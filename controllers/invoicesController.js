const db = require("../config/db");

// Helper function to log invoice actions - RUNS OUTSIDE TRANSACTION
const logInvoiceAction = async (invoiceId, action, details, changes = {}, req = null) => {
  // Run in a separate connection to avoid transaction locks
  setImmediate(async () => {
    try {
      const userId = req?.user?.id || null;
      const ipAddress = req?.ip || req?.connection?.remoteAddress || null;
      const userAgent = req?.get('user-agent') || null;
      
      let userName = 'System';
      
      // If user ID exists, fetch user name from users table
      if (userId) {
        try {
          const [users] = await db.execute(
            'SELECT name FROM users WHERE id = ?',
            [userId]
          );
          
          if (users.length > 0) {
            userName = users[0].name;
          } else {
            console.warn(`⚠️ User not found with ID: ${userId}`);
            userName = 'Unknown User';
          }
        } catch (userErr) {
          console.error("❌ Error fetching user name:", userErr);
          userName = 'Error Fetching Name';
        }
      }

      await db.execute(
        `INSERT INTO invoice_history 
         (invoiceId, action, userId, userName, changes, details, ipAddress, userAgent) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId,
          action,
          userId,
          userName,
          JSON.stringify(changes),
          details,
          ipAddress,
          userAgent
        ]
      );
      
      console.log(`📝 Invoice history created for action: ${action} by user: ${userName}`);
    } catch (err) {
      console.error("❌ Error logging invoice action:", err);
      // Don't throw - logging should not break the main operation
    }
  });
};

// Helper function to calculate item base amount
function calculateItemBaseAmount(item) {
  if (item.isPercentageQty && item.percentageValue) {
    // Percentage mode: calculate based on percentage of rate
    return (item.percentageValue / 100) * item.rate;
  } else {
    // Regular quantity mode
    return item.quantity * item.rate;
  }
}

// Helper function to calculate all item amounts with GST applicability check
function calculateItemAmounts(item, taxType = 'sgst_cgst', gstApplicable = true) {
  const baseAmount = calculateItemBaseAmount(item);
  const discountAmount = item.discount ? (baseAmount * item.discount) / 100 : 0;
  const taxableAmount = baseAmount - discountAmount;
  
  // Calculate taxes based on tax type and GST applicability
  let taxAmount = 0;
  let sgstAmount = 0;
  let cgstAmount = 0;
  let igstAmount = 0;

  if (gstApplicable) {
    if (taxType === 'sgst_cgst') {
      sgstAmount = (taxableAmount * (item.sgst || 9)) / 100;
      cgstAmount = (taxableAmount * (item.cgst || 9)) / 100;
      taxAmount = sgstAmount + cgstAmount;
    } else if (taxType === 'igst') {
      igstAmount = (taxableAmount * (item.igst || 18)) / 100;
      taxAmount = igstAmount;
    }
  }
  // If GST is not applicable, all tax amounts remain 0

  const totalAmount = taxableAmount;

  return {
    baseAmount,
    discountAmount,
    taxableAmount,
    taxAmount,
    sgstAmount,
    cgstAmount,
    igstAmount,
    totalAmount
  };
}

// Helper function to handle base64 signature
const handleSignature = (signatureData) => {
  if (!signatureData) return null;
  
  // If it's already a base64 string, return it
  if (typeof signatureData === 'string' && signatureData.startsWith('data:image/')) {
    return signatureData;
  }
  
  // If it's our default signature image path, return it as is
  if (typeof signatureData === 'string' && signatureData.includes('signature (2).png')) {
    return signatureData;
  }
  
  // If it's a URL (like localhost), return null to avoid storing URLs
  if (typeof signatureData === 'string' && signatureData.startsWith('http')) {
    console.warn('Signature is a URL, expecting base64 data URL. Please convert signature to base64 on frontend.');
    return null;
  }
  
  return signatureData;
};

// ==================== INVOICE NUMBER HELPER FUNCTIONS ====================

// Helper to get next sequence number for project
const getNextSequence = async (conn, projectId = null, prefix = 'ICE/25-26/INV/', invoiceType = 'sales') => {
  try {
    // First, try to lock the existing row
    const [existing] = await conn.execute(
      'SELECT * FROM invoice_sequences WHERE project_id <=> ? AND prefix = ? AND invoice_type = ? FOR UPDATE',
      [projectId, prefix, invoiceType]
    );
    
    if (existing.length === 0) {
      // No existing sequence - create a new one
      try {
        await conn.execute(
          'INSERT INTO invoice_sequences (project_id, prefix, invoice_type, last_sequence) VALUES (?, ?, ?, 0)',
          [projectId, prefix, invoiceType]
        );
        console.log(`Created new sequence for project ${projectId}, prefix ${prefix}`);
        return 1;
      } catch (insertErr) {
        // If insert fails due to duplicate, try to fetch again
        if (insertErr.code === 'ER_DUP_ENTRY' || insertErr.errno === 1062) {
          const [retry] = await conn.execute(
            'SELECT * FROM invoice_sequences WHERE project_id <=> ? AND prefix = ? AND invoice_type = ? FOR UPDATE',
            [projectId, prefix, invoiceType]
          );
          if (retry.length > 0) {
            return retry[0].last_sequence + 1;
          }
        }
        throw insertErr;
      }
    }
    
    // Existing sequence found
    const nextSequence = existing[0].last_sequence + 1;
    return nextSequence;
  } catch (error) {
    console.error('Error getting next sequence:', error);
    throw error;
  }
};

// Helper to update sequence after invoice creation
const updateSequence = async (conn, projectId = null, prefix = 'ICE/25-26/INV/', sequence, invoiceType = 'sales') => {
  await conn.execute(
    'UPDATE invoice_sequences SET last_sequence = ? WHERE project_id = ? AND prefix = ? AND invoice_type = ?',
    [sequence, projectId, prefix, invoiceType]
  );
};

// FIXED: Better project ID handling and NULL comparison
const validateInvoiceNumber = async (conn, invoiceNumber, projectId = null, excludeId = null) => {
  try {
    console.log('Validating invoice number:', {
      invoiceNumber,
      projectId,
      excludeId,
      projectIdType: typeof projectId,
      projectIdValue: projectId,
      isNull: projectId === null,
      isUndefined: projectId === undefined
    });
    
    // Build query with proper NULL handling
    let query = `
      SELECT COUNT(*) as count 
      FROM invoices 
      WHERE invoice_number_generated = ? 
        AND type = 'sales'
    `;
    
    const params = [invoiceNumber];
    
    // CRITICAL FIX: Handle project_id properly for both NULL and actual values
    if (projectId === null || projectId === undefined || projectId === 'null' || projectId === 'undefined') {
      // Check for invoices without project (project_id IS NULL)
      query += ' AND (project_id IS NULL OR project_id = ?)';
      params.push(null);
    } else {
      // Check for invoices with specific project
      query += ' AND project_id = ?';
      params.push(projectId);
    }
    
    if (excludeId) {
      query += ' AND id != ?';
      params.push(excludeId);
    }
    
    console.log('Validation query:', query);
    console.log('Validation params:', params);
    
    const [result] = await conn.execute(query, params);
    const isValid = result[0].count === 0;
    
    console.log('Validation result:', {
      count: result[0].count,
      isValid: isValid
    });
    
    return isValid;
  } catch (error) {
    console.error('Error validating invoice number:', error);
    throw error;
  }
};

// Update the parseInvoiceNumber function to better handle prefixes
const parseInvoiceNumber = (fullNumber, defaultPrefix = 'ICE/25-26/INV/') => {
  if (!fullNumber) return { sequence: null, number: null, prefix: defaultPrefix };
  
  // Try to extract prefix (everything up to the last '/')
  const lastSlashIndex = fullNumber.lastIndexOf('/');
  let prefix = defaultPrefix;
  let sequenceStr = fullNumber;
  
  if (lastSlashIndex !== -1) {
    prefix = fullNumber.substring(0, lastSlashIndex + 1);
    sequenceStr = fullNumber.substring(lastSlashIndex + 1);
  }
  
  // For manual numbers, don't force to integer
  let sequence;
  if (/^\d+$/.test(sequenceStr)) {
    sequence = parseInt(sequenceStr);
  } else {
    sequence = null;
  }
  
  return {
    sequence: sequence,
    number: fullNumber,
    sequenceStr: sequenceStr,
    prefix: prefix
  };
};

// Helper function to get proper project ID for validation
const getProjectIdForValidation = (projectId) => {
  // Handle all possible cases
  if (projectId === null || projectId === undefined || projectId === 'null' || projectId === 'undefined') {
    return null;
  }
  
  if (typeof projectId === 'string') {
    const parsed = parseInt(projectId);
    return isNaN(parsed) ? null : parsed;
  }
  
  return projectId;
};

// ==================== API ROUTES ====================

// Get history logs for a sales invoice
exports.getHistory = async (req, res) => {
  try {
    const [logs] = await db.execute(
      `SELECT * FROM invoice_history 
       WHERE invoiceId = ? 
       ORDER BY createdAt DESC`,
      [req.params.id]
    );

    // Parse JSON changes field
    const parsedLogs = logs.map(log => ({
      ...log,
      changes: log.changes ? (typeof log.changes === 'string' ? JSON.parse(log.changes) : log.changes) : {}
    }));

    res.json(parsedLogs);
  } catch (err) {
    console.error("Error fetching invoice history:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// List all SALES invoices with client + items + project details
exports.list = async (req, res) => {
  try {
    const [invoices] = await db.execute(`
      SELECT i.*, c.name as clientName, p.project_name as projectName
      FROM invoices i
      LEFT JOIN clients c ON i.clientId = c.id
      LEFT JOIN projects p ON i.project_id = p.id
      WHERE i.type = 'sales'
      ORDER BY i.createdAt DESC
    `);

    for (const inv of invoices) {
      // Get invoice items with full item details
      const [items] = await db.execute(`
        SELECT 
          ii.*,
          it.id as original_item_id,
          it.name as original_item_name,
          it.description as original_item_description,
          it.hsnCode as original_hsn_code,
          it.measuringUnit as original_measuring_unit,
          it.sellingPrice as original_selling_price,
          it.createdAt as item_created_at,
          it.updatedAt as item_updated_at
        FROM invoice_items ii
        LEFT JOIN items it ON ii.itemId = it.id
        WHERE ii.invoiceId = ?
      `, [inv.id]);
      
      inv.items = items;

      // Parse meta data for project information and GST applicability
      if (inv.meta) {
        if (typeof inv.meta === 'string') {
          try {
            inv.meta = JSON.parse(inv.meta);
          } catch (e) {
            console.error("Error parsing invoice meta:", e);
            inv.meta = {};
          }
        }
      } else {
        inv.meta = {};
      }

      // Add GST applicability info
      inv.gstApplicable = inv.meta.gstApplicable !== false; // Default to true if not specified

      // Add project information from meta if available
      if (inv.meta.projectId) {
        inv.projectId = inv.meta.projectId;
        inv.projectName = inv.meta.projectName || inv.projectName;
      }
    }

    res.json(invoices);
  } catch (err) {
    console.error("Error fetching sales invoices:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get single SALES invoice by ID with project details
exports.get = async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT i.*, p.project_name as projectName 
       FROM invoices i 
       LEFT JOIN projects p ON i.project_id = p.id 
       WHERE i.id = ? AND i.type = 'sales'`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Sales invoice not found" });

    const invoice = rows[0];

    // Handle meta data
    if (invoice.meta) {
      if (typeof invoice.meta === 'string') {
        try {
          invoice.meta = JSON.parse(invoice.meta);
        } catch (e) {
          console.error("Error parsing invoice meta:", e);
          invoice.meta = {};
        }
      }
    } else {
      invoice.meta = {};
    }

    // Extract GST applicability and tax type from meta
    const gstApplicable = invoice.meta.gstApplicable !== false; // Default to true if not specified
    const taxType = gstApplicable ? (invoice.meta.taxType || 'sgst_cgst') : 'none';

    const [client] = await db.execute(
      "SELECT * FROM clients WHERE id = ?",
      [invoice.clientId]
    );
    invoice.client = client[0] || null;

    // Get invoice items with full item details
    const [items] = await db.execute(`
      SELECT 
        ii.*,
        it.id as original_item_id,
        it.name as original_item_name,
        it.description as original_item_description,
        it.hsnCode as original_hsn_code,
        it.measuringUnit as original_measuring_unit,
        it.sellingPrice as original_selling_price,
        it.createdAt as item_created_at,
        it.updatedAt as item_updated_at
      FROM invoice_items ii
      LEFT JOIN items it ON ii.itemId = it.id
      WHERE ii.invoiceId = ?
    `, [invoice.id]);
    
    // Parse meta data for each item
    invoice.items = items.map(item => {
      if (item.meta) {
        if (typeof item.meta === 'string') {
          try {
            item.meta = JSON.parse(item.meta);
          } catch (e) {
            console.error("Error parsing item meta:", e);
            item.meta = {};
          }
        }
        if (typeof item.meta === 'object' && item.meta !== null && gstApplicable) {
          item.sgst = item.meta.sgst || 9;
          item.cgst = item.meta.cgst || 9;
          item.igst = item.meta.igst || 18;
          item.sgstAmount = item.meta.sgstAmount || 0;
          item.cgstAmount = item.meta.cgstAmount || 0;
          item.igstAmount = item.meta.igstAmount || 0;
          item.percentageValue = item.meta.percentageValue || null;
          item.isPercentageQty = item.meta.isPercentageQty || false;
        } else if (!gstApplicable) {
          // Reset all tax values to 0 if GST is not applicable
          item.sgst = 0;
          item.cgst = 0;
          item.igst = 0;
          item.sgstAmount = 0;
          item.cgstAmount = 0;
          item.igstAmount = 0;
        }
      } else {
        item.meta = {};
      }
      
      // Add original item details to the response
      item.originalItem = item.original_item_id ? {
        id: item.original_item_id,
        name: item.original_item_name,
        description: item.original_item_description,
        hsnCode: item.original_hsn_code,
        measuringUnit: item.original_measuring_unit,
        sellingPrice: item.original_selling_price,
        tax: item.original_tax,
        createdAt: item.item_created_at,
        updatedAt: item.item_updated_at
      } : null;
      
      return item;
    });

    // Add project information from meta if available
    if (invoice.meta.projectId) {
      invoice.projectId = invoice.meta.projectId;
      invoice.projectName = invoice.meta.projectName || invoice.projectName;
    }

    // Add GST applicability and tax type to invoice response
    invoice.gstApplicable = gstApplicable;
    invoice.taxType = taxType;

    res.json(invoice);
  } catch (err) {
    console.error("Error fetching sales invoice:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get sales invoices by project
exports.getInvoicesByProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    
    const [invoices] = await db.execute(`
      SELECT i.*, c.name as clientName, p.project_name as projectName
      FROM invoices i
      LEFT JOIN clients c ON i.clientId = c.id
      LEFT JOIN projects p ON i.project_id = p.id
      WHERE i.type = 'sales' AND i.project_id = ?
      ORDER BY i.createdAt DESC
    `, [projectId]);

    for (const inv of invoices) {
      // Get invoice items with full item details
      const [items] = await db.execute(`
        SELECT 
          ii.*,
          it.id as original_item_id,
          it.name as original_item_name,
          it.description as original_item_description,
          it.hsnCode as original_hsn_code,
          it.measuringUnit as original_measuring_unit,
          it.sellingPrice as original_selling_price,
          it.tax as original_tax,
          it.createdAt as item_created_at,
          it.updatedAt as item_updated_at
        FROM invoice_items ii
        LEFT JOIN items it ON ii.itemId = it.id
        WHERE ii.invoiceId = ?
      `, [inv.id]);
      
      // Parse meta data for invoice
      if (inv.meta && typeof inv.meta === 'string') {
        try {
          inv.meta = JSON.parse(inv.meta);
        } catch (e) {
          console.error("Error parsing invoice meta:", e);
          inv.meta = {};
        }
      } else if (!inv.meta) {
        inv.meta = {};
      }

      // Get GST applicability from meta
      const gstApplicable = inv.meta.gstApplicable !== false; // Default to true

      inv.items = items.map(item => {
        if (item.meta) {
          if (typeof item.meta === 'string') {
            try {
              item.meta = JSON.parse(item.meta);
            } catch (e) {
              console.error("Error parsing item meta:", e);
              item.meta = {};
            }
          }
          if (typeof item.meta === 'object' && item.meta !== null && gstApplicable) {
            item.sgst = item.meta.sgst || 9;
            item.cgst = item.meta.cgst || 9;
            item.igst = item.meta.igst || 18;
            item.sgstAmount = item.meta.sgstAmount || 0;
            item.cgstAmount = item.meta.cgstAmount || 0;
            item.igstAmount = item.meta.igstAmount || 0;
            item.percentageValue = item.meta.percentageValue || null;
            item.isPercentageQty = item.meta.isPercentageQty || false;
          } else if (!gstApplicable) {
            // Reset all tax values to 0 if GST is not applicable
            item.sgst = 0;
            item.cgst = 0;
            item.igst = 0;
            item.sgstAmount = 0;
            item.cgstAmount = 0;
            item.igstAmount = 0;
          }
        } else {
          item.meta = {};
        }
        
        // Add original item details to the response
        item.originalItem = item.original_item_id ? {
          id: item.original_item_id,
          name: item.original_item_name,
          description: item.original_item_description,
          hsnCode: item.original_hsn_code,
          measuringUnit: item.original_measuring_unit,
          sellingPrice: item.original_selling_price,
          tax: item.original_tax,
          createdAt: item.item_created_at,
          updatedAt: item.item_updated_at
        } : null;
        
        return item;
      });

      // Add GST applicability info
      inv.gstApplicable = gstApplicable;

      // Add project information from meta if available
      if (inv.meta.projectId) {
        inv.projectId = inv.meta.projectId;
        inv.projectName = inv.meta.projectName || inv.projectName;
      }
    }

    res.json({ invoices: invoices });
  } catch (err) {
    console.error("Error fetching project sales invoices:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get next invoice number
exports.getNextInvoiceNumber = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    const { projectId, prefix = 'ICE/25-26/INV/' } = req.query;
    
    // Get proper project ID
    const validatedProjectId = getProjectIdForValidation(projectId);
    
    // Get current max sequence
    const [sequences] = await conn.execute(
      'SELECT last_sequence FROM invoice_sequences WHERE project_id <=> ? AND prefix = ? AND invoice_type = ?',
      [validatedProjectId, prefix, 'sales']
    );
    
    let nextSequence = 1;
    if (sequences.length > 0) {
      nextSequence = sequences[0].last_sequence + 1;
    } else {
      // Check if there's any existing invoice for this project/global
      let query = `
        SELECT MAX(invoice_sequence) as max_sequence 
        FROM invoices 
        WHERE invoice_prefix = ? 
          AND type = 'sales'
      `;
      
      const params = [prefix];
      
      if (validatedProjectId !== null) {
        query += ' AND project_id = ?';
        params.push(validatedProjectId);
      } else {
        query += ' AND project_id IS NULL';
      }
      
      const [invoices] = await conn.execute(query, params);
      
      if (invoices[0].max_sequence) {
        nextSequence = invoices[0].max_sequence + 1;
      }
    }
    
    conn.release();
    
    res.json({
      success: true,
      nextSequence,
      nextInvoiceNumber: `${prefix}${nextSequence.toString().padStart(4, '0')}`,
      projectId: validatedProjectId,
      prefix
    });
  } catch (error) {
    if (conn) conn.release();
    console.error('Error getting next invoice number:', error);
    res.status(500).json({ 
      success: false,
      message: 'Database error' 
    });
  }
};

// Check invoice number availability - UPDATED
exports.checkInvoiceNumber = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    const { invoiceNumber, projectId } = req.query;
    
    if (!invoiceNumber) {
      return res.status(400).json({ 
        success: false,
        message: 'Invoice number is required' 
      });
    }
    
    // Get proper project ID
    const validatedProjectId = getProjectIdForValidation(projectId);
    
    console.log('Checking invoice number:', {
      invoiceNumber,
      originalProjectId: projectId,
      validatedProjectId
    });
    
    // Check if the number already exists
    const isValid = await validateInvoiceNumber(
      conn,
      invoiceNumber,
      validatedProjectId, // Use validated project ID
      null
    );
    
    conn.release();
    
    res.json({
      success: true,
      available: isValid,
      invoiceNumber,
      projectId: validatedProjectId
    });
  } catch (error) {
    if (conn) conn.release();
    console.error('Error checking invoice number:', error);
    res.status(500).json({ 
      success: false,
      message: 'Database error' 
    });
  }
};

// Create SALES invoice - FIXED
// Create SALES invoice - FIXED
exports.create = async (req, res) => {
  const payload = req.body;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    console.log("Creating sales invoice for project:", payload.projectId);
    console.log("Payload invoice number:", payload.manualInvoiceNumber);

    let originalProjectBudget = null;
    let currentProjectBudget = null;

    // Get GST applicability from payload (default to true if not specified)
    const gstApplicable = payload.gstApplicable !== false;
    console.log("GST Applicable:", gstApplicable);

    // Get tax type based on GST applicability
    const taxType = gstApplicable ? (payload.taxType || 'sgst_cgst') : 'none';
    console.log("Tax Type:", taxType);

    // Get proper project ID
    const validatedProjectId = getProjectIdForValidation(payload.projectId);

    // Project Budget Validation
    if (validatedProjectId !== null) {
      console.log("Checking project budget for project ID:", validatedProjectId);
      
      // Get project details with meta_data
      const [projects] = await conn.execute(
        "SELECT * FROM projects WHERE id = ?",
        [validatedProjectId]
      );
      
      if (projects.length === 0) {
        await conn.rollback();
        return res.status(400).json({ 
          message: "Project not found" 
        });
      }

      const project = projects[0];
      
      // Parse project meta_data to check for budget
      let projectMeta = {};
      if (project.meta_data) {
        try {
          projectMeta = typeof project.meta_data === 'string' 
            ? JSON.parse(project.meta_data) 
            : project.meta_data;
        } catch (e) {
          console.error("Error parsing project meta_data:", e);
        }
      }
      
      // Check if project has budget amount
      if (projectMeta.amount !== undefined && projectMeta.amount !== null) {
        currentProjectBudget = parseFloat(projectMeta.amount);
        originalProjectBudget = currentProjectBudget; // Store original budget
        console.log("Project budget amount:", currentProjectBudget);
        
        if (!isNaN(currentProjectBudget) && currentProjectBudget > 0) {
          // Calculate invoice total for validation
          const taxType = gstApplicable ? (payload.taxType || 'sgst_cgst') : 'none';

          // Calculate subtotal using the helper function
          const subtotal = payload.items.reduce((sum, item) => {
            return sum + calculateItemBaseAmount(item);
          }, 0);
          
          const discountValue = payload.discount && payload.discount.type === "percent" 
            ? (subtotal * payload.discount.value) / 100 
            : (payload.discount?.value || 0);
          
          const additionalChargesTotal = payload.additionalCharges?.reduce((sum, charge) => sum + charge.amount, 0) || 0;
          
          const taxable = subtotal - discountValue + additionalChargesTotal;
          const tcs = payload.applyTCS ? taxable * 0.01 : 0;
          
          // Calculate total tax based on GST applicability
          let totalTax = 0;
          let sgstTotal = 0;
          let cgstTotal = 0;
          let igstTotal = 0;

          if (gstApplicable) {
            payload.items.forEach(item => {
              const amounts = calculateItemAmounts(item, taxType, true);
              totalTax += amounts.taxAmount;
              sgstTotal += amounts.sgstAmount;
              cgstTotal += amounts.cgstAmount;
              igstTotal += amounts.igstAmount;
            });
          }

          // Apply rounding if enabled
          let calculatedTotal;
          if (gstApplicable) {
            calculatedTotal = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;
          } else {
            calculatedTotal = taxable + tcs; // No tax when GST is not applicable
          }
          
          const finalTotal = payload.roundingApplied ? Math.round(calculatedTotal) : calculatedTotal;
          
          console.log("Invoice total amount:", finalTotal, "Project budget:", currentProjectBudget);
          
          // Validate if invoice amount exceeds project budget
          if (finalTotal > currentProjectBudget) {
            await conn.rollback();
            return res.status(400).json({ 
              message: `Invoice amount (₹${finalTotal.toFixed(2)}) exceeds project budget (₹${currentProjectBudget.toFixed(2)})`,
              invoiceAmount: finalTotal,
              projectBudget: currentProjectBudget,
              exceedsBy: finalTotal - currentProjectBudget
            });
          }
          
          console.log("Invoice amount is within project budget");
        }
      }
    }

    // Handle signature - convert to base64 if provided
    const signatureBase64 = handleSignature(payload.signature);
    
    if (payload.signature && !signatureBase64) {
      console.warn('Signature provided but not in base64 format. Signature will not be saved.');
    }

    // Calculate subtotal using the helper function
    const subtotal = payload.items.reduce((sum, item) => {
      return sum + calculateItemBaseAmount(item);
    }, 0);
    
    console.log("Calculated subtotal:", subtotal);

    const discountValue = payload.discount && payload.discount.type === "percent" 
      ? (subtotal * payload.discount.value) / 100 
      : (payload.discount?.value || 0);
    
    const additionalChargesTotal = payload.additionalCharges?.reduce((sum, charge) => sum + charge.amount, 0) || 0;
    
    const taxable = subtotal - discountValue + additionalChargesTotal;
    const tcs = payload.applyTCS ? taxable * 0.01 : 0;
    
    // Calculate total tax based on GST applicability
    let totalTax = 0;
    let sgstTotal = 0;
    let cgstTotal = 0;
    let igstTotal = 0;

    if (gstApplicable) {
      payload.items.forEach(item => {
        const amounts = calculateItemAmounts(item, taxType, true);
        totalTax += amounts.taxAmount;
        sgstTotal += amounts.sgstAmount;
        cgstTotal += amounts.cgstAmount;
        igstTotal += amounts.igstAmount;
      });
    }
    
    // Apply rounding if enabled
    let calculatedTotal;
    if (gstApplicable) {
      calculatedTotal = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;
    } else {
      calculatedTotal = taxable + tcs; // No tax when GST is not applicable
    }
    
    const finalTotal = payload.roundingApplied ? Math.round(calculatedTotal) : calculatedTotal;

    // ==================== INVOICE NUMBER HANDLING ====================
    let invoiceSequence;
    let generatedNumber;
    let isManualInvoice = false;
    let originalSequence = null;
    let sequenceStr = null;
    let invoicePrefix = payload.invoicePrefix || 'ICE/25-26/INV/';

    if (payload.manualInvoiceNumber) {
      // User provided manual invoice number
      console.log("Using manual invoice number:", payload.manualInvoiceNumber);
      
      // Parse the manual number with its actual prefix
      const parsed = parseInvoiceNumber(payload.manualInvoiceNumber, invoicePrefix);
      
      if (!parsed.number) {
        await conn.rollback();
        return res.status(400).json({ 
          message: "Invalid invoice number format" 
        });
      }
      
      // Use the actual prefix from the parsed number
      invoicePrefix = parsed.prefix;
      generatedNumber = parsed.number;
      
      // CRITICAL FIX: Validate uniqueness with proper project ID
      const isValid = await validateInvoiceNumber(
        conn,
        generatedNumber,
        validatedProjectId, // Use validated project ID
        null
      );
      
      if (!isValid) {
        await conn.rollback();
        return res.status(400).json({
          message: `Invoice number "${generatedNumber}" already exists ${validatedProjectId !== null ? 'for this project' : 'globally'}`,
          available: false,
          existingInvoice: true
        });
      }
      
      invoiceSequence = parsed.sequence || 0;
      isManualInvoice = true;
      originalSequence = parsed.sequence || null;
      sequenceStr = parsed.sequenceStr;
      
      console.log('Parsed manual number:', {
        generatedNumber,
        invoicePrefix,
        invoiceSequence,
        sequenceStr,
        isManualInvoice,
        projectId: validatedProjectId
      });
      
      // Update sequence tracker if needed (only for numeric sequences)
      if (parsed.sequence && !isNaN(parsed.sequence)) {
        // Use INSERT ... ON DUPLICATE KEY UPDATE to avoid race conditions
        try {
          await conn.execute(
            `INSERT INTO invoice_sequences (project_id, prefix, invoice_type, last_sequence) 
             VALUES (?, ?, ?, ?) 
             ON DUPLICATE KEY UPDATE last_sequence = GREATEST(last_sequence, VALUES(last_sequence))`,
            [validatedProjectId, invoicePrefix, 'sales', parsed.sequence]
          );
        } catch (seqErr) {
          console.warn('Error updating sequence for manual number:', seqErr);
          // Continue even if sequence update fails for manual numbers
        }
      }
    } else {
      // Auto-generate invoice number
      console.log("Auto-generating invoice number for project:", validatedProjectId);
      
      // FIXED: Use INSERT ... ON DUPLICATE KEY UPDATE to handle race conditions
      try {
        // First ensure the sequence record exists with last_sequence = 0
        await conn.execute(
          `INSERT INTO invoice_sequences (project_id, prefix, invoice_type, last_sequence) 
           VALUES (?, ?, ?, 0) 
           ON DUPLICATE KEY UPDATE project_id = project_id`,
          [validatedProjectId, invoicePrefix, 'sales']
        );
        
        // Now lock and increment
        const [existing] = await conn.execute(
          'SELECT last_sequence FROM invoice_sequences WHERE project_id <=> ? AND prefix = ? AND invoice_type = ? FOR UPDATE',
          [validatedProjectId, invoicePrefix, 'sales']
        );
        
        if (existing.length === 0) {
          // Should not happen after the INSERT
          invoiceSequence = 1;
          await conn.execute(
            'INSERT INTO invoice_sequences (project_id, prefix, invoice_type, last_sequence) VALUES (?, ?, ?, ?)',
            [validatedProjectId, invoicePrefix, 'sales', 1]
          );
        } else {
          invoiceSequence = existing[0].last_sequence + 1;
          await conn.execute(
            'UPDATE invoice_sequences SET last_sequence = ? WHERE project_id <=> ? AND prefix = ? AND invoice_type = ?',
            [invoiceSequence, validatedProjectId, invoicePrefix, 'sales']
          );
        }
      } catch (seqErr) {
        // Fallback: try to get the next sequence with a simpler approach
        console.warn('Sequence handling error, using fallback:', seqErr);
        
        if (seqErr.code === 'ER_DUP_ENTRY' || seqErr.errno === 1062) {
          // Duplicate entry error - sequence already exists
          const [existing] = await conn.execute(
            'SELECT last_sequence FROM invoice_sequences WHERE project_id <=> ? AND prefix = ? AND invoice_type = ? FOR UPDATE',
            [validatedProjectId, invoicePrefix, 'sales']
          );
          
          if (existing.length > 0) {
            invoiceSequence = existing[0].last_sequence + 1;
            await conn.execute(
              'UPDATE invoice_sequences SET last_sequence = ? WHERE project_id <=> ? AND prefix = ? AND invoice_type = ?',
              [invoiceSequence, validatedProjectId, invoicePrefix, 'sales']
            );
          } else {
            // Try to get max sequence from existing invoices
            let query = `
              SELECT MAX(invoice_sequence) as max_sequence 
              FROM invoices 
              WHERE invoice_prefix = ? 
                AND type = 'sales'
                AND project_id <=> ?
            `;
            
            const [invoices] = await conn.execute(query, [invoicePrefix, validatedProjectId]);
            
            if (invoices[0].max_sequence) {
              invoiceSequence = invoices[0].max_sequence + 1;
            } else {
              invoiceSequence = 1;
            }
            
            // Try to insert the sequence record one more time
            try {
              await conn.execute(
                'INSERT INTO invoice_sequences (project_id, prefix, invoice_type, last_sequence) VALUES (?, ?, ?, ?)',
                [validatedProjectId, invoicePrefix, 'sales', invoiceSequence]
              );
            } catch (insertErr) {
              // If still duplicate, just use the sequence we calculated
              console.warn('Could not insert sequence record, using calculated sequence:', insertErr);
            }
          }
        } else {
          throw seqErr;
        }
      }
      
      // Generate the full invoice number with padding
      generatedNumber = `${invoicePrefix}${invoiceSequence.toString().padStart(4, '0')}`;
      
      // Double-check uniqueness (in case of race condition)
      const isValid = await validateInvoiceNumber(
        conn,
        generatedNumber,
        validatedProjectId,
        null
      );
      
      if (!isValid) {
        await conn.rollback();
        return res.status(400).json({
          message: `Generated invoice number "${generatedNumber}" already exists. Please try again.`,
          available: false
        });
      }
      
      sequenceStr = invoiceSequence.toString().padStart(4, '0');
      console.log("Generated invoice number:", generatedNumber);
    }

    // Create meta object with tax type, GST applicability and project details
    const meta = {
      taxType: taxType,
      gstApplicable: gstApplicable,
      discount: payload.discount || { type: "flat", value: 0 },
      discountValue: discountValue,
      additionalCharges: payload.additionalCharges || [],
      additionalChargesTotal: additionalChargesTotal,
      applyTCS: payload.applyTCS || false,
      tcs: tcs,
      taxableAmount: taxable,
      sgstTotal: gstApplicable && taxType === 'sgst_cgst' ? sgstTotal : 0,
      cgstTotal: gstApplicable && taxType === 'sgst_cgst' ? cgstTotal : 0,
      igstTotal: gstApplicable && taxType === 'igst' ? igstTotal : 0,
      totalTax: totalTax,
      
      // Rounding information
      roundingApplied: payload.roundingApplied || false,
      originalTotal: payload.originalTotal || calculatedTotal,
      roundedTotal: payload.roundedTotal || finalTotal,
      roundingDifference: payload.roundingDifference || (payload.roundingApplied ? (finalTotal - calculatedTotal) : 0),
      
      // Project information (also stored in meta for easy access)
      projectId: validatedProjectId,
      projectName: payload.projectName || null,
      
      // Store original project budget for future validation during updates
      originalProjectBudget: originalProjectBudget,
      invoiceCreatedAtBudget: currentProjectBudget,
      
      amountReceived: payload.amountReceived || 0,
      paymentMode: payload.paymentMode || "Cash",
      paymentTerms: payload.paymentTerms || "",
      bankDetails: payload.bankDetails || null,
      billingAddress: payload.billingAddress || "",
      shippingAddress: payload.shippingAddress || "",
      poNumber: payload.poNumber || "",
      ewayBillNumber: payload.ewayBillNumber || "",
      vendorCode: payload.vendorCode || "",
      poDate: payload.poDate || null,
      
      // Invoice number information
      isManualInvoice: isManualInvoice,
      invoicePrefix: invoicePrefix,
      generatedInvoiceNumber: generatedNumber
    };

    // Insert invoice with new columns - use sequenceStr for invoiceNumber field
    const [result] = await conn.execute(
      `INSERT INTO invoices 
      (invoice_prefix, invoice_sequence, invoice_number_generated, is_manual_invoice, original_sequence, 
       invoiceNumber, date, dueDate, clientId, status, subTotal, tax, discount, total, notes, signature, 
       type, meta, project_id, createdAt, updatedAt) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        invoicePrefix,
        invoiceSequence,
        generatedNumber,
        isManualInvoice,
        originalSequence,
        sequenceStr, // Store the sequence string (actual value entered)
        payload.date,
        payload.dueDate,
        payload.clientId,
        payload.status || "draft",
        subtotal,
        totalTax,
        payload.totalDiscountAmount || discountValue,
        payload.total || finalTotal,
        JSON.stringify(payload.notes || []),
        signatureBase64,
        'sales',
        JSON.stringify(meta),
        validatedProjectId
      ]
    );

    const invoiceId = result.insertId;

    // Update project budget after successful invoice creation
    if (validatedProjectId !== null && currentProjectBudget !== null) {
      console.log("Updating project budget for project ID:", validatedProjectId);
      
      // Get project details again to ensure we have latest data
      const [projects] = await conn.execute(
        "SELECT * FROM projects WHERE id = ?",
        [validatedProjectId]
      );
      
      if (projects.length > 0) {
        const project = projects[0];
        let projectMeta = {};
        
        // Parse existing meta_data
        if (project.meta_data) {
          try {
            projectMeta = typeof project.meta_data === 'string' 
              ? JSON.parse(project.meta_data) 
              : project.meta_data;
          } catch (e) {
            console.error("Error parsing project meta_data:", e);
          }
        }
        
        // Update project budget
        const newBudgetAmount = currentProjectBudget - finalTotal;
        projectMeta.amount = newBudgetAmount;
        
        // Update the project in database
        await conn.execute(
          "UPDATE projects SET meta_data = ? WHERE id = ?",
          [JSON.stringify(projectMeta), validatedProjectId]
        );
        
        console.log(`Project budget updated: ₹${currentProjectBudget.toFixed(2)} -> ₹${newBudgetAmount.toFixed(2)}`);
      }
    }

    // Insert items with correct amount calculations
    for (const item of payload.items) {
      const amounts = calculateItemAmounts(item, taxType, gstApplicable);

      // Create item meta with tax information based on GST applicability
      const itemMeta = {
        sgst: gstApplicable && taxType === 'sgst_cgst' ? (item.sgst || 9) : 0,
        cgst: gstApplicable && taxType === 'sgst_cgst' ? (item.cgst || 9) : 0,
        igst: gstApplicable && taxType === 'igst' ? (item.igst || 18) : 0,
        sgstAmount: parseFloat(amounts.sgstAmount.toFixed(2)),
        cgstAmount: parseFloat(amounts.cgstAmount.toFixed(2)),
        igstAmount: parseFloat(amounts.igstAmount.toFixed(2)),
        taxableAmount: parseFloat(amounts.taxableAmount.toFixed(2)),
        percentageValue: item.percentageValue ? parseFloat(item.percentageValue) : null,
        isPercentageQty: Boolean(item.isPercentageQty)
      };

      // Store the actual quantity used in calculation
      const quantityToStore = item.isPercentageQty ? 
        (item.percentageValue || 0) :
        item.quantity;

      // Insert item with productId
      await conn.execute(
        `INSERT INTO invoice_items 
        (invoiceId, itemId, description, hsn, uom, quantity, rate, discount, tax, taxAmount, amount, meta) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId,
          item.itemId || null,
          item.description,
          item.hsn || '',
          item.uom || '',
          parseFloat(quantityToStore),
          parseFloat(item.rate.toFixed(2)),
          parseFloat((item.discountAmount || 0).toFixed(2)),
          parseFloat((item.tax || 0).toFixed(2)),
          parseFloat(amounts.taxAmount.toFixed(2)),
          parseFloat(amounts.totalAmount.toFixed(2)),
          JSON.stringify(itemMeta)
        ]
      );
    }

    // Commit transaction FIRST
    await conn.commit();

    // THEN log the creation action OUTSIDE the transaction
    logInvoiceAction(
      invoiceId,
      'created',
      `Sales invoice ${generatedNumber} created with ${payload.items.length} items ${gstApplicable ? '' : '(GST Exempt)'} ${isManualInvoice ? '(manual number)' : '(auto-generated)'}`,
      {
        invoiceNumber: generatedNumber,
        invoiceSequence: invoiceSequence,
        sequenceString: sequenceStr,
        isManualInvoice: isManualInvoice,
        client: payload.clientId,
        total: payload.total || finalTotal,
        items: payload.items.length,
        taxType: taxType,
        gstApplicable: gstApplicable,
        status: payload.status || "draft",
        projectId: validatedProjectId,
        projectBudgetUsed: finalTotal,
        originalProjectBudget: originalProjectBudget
      },
      req
    );

    res.status(201).json({ 
      message: "Sales invoice created", 
      id: invoiceId,
      invoiceNumber: generatedNumber,
      invoiceSequence: invoiceSequence,
      sequenceString: sequenceStr,
      isManualInvoice: isManualInvoice,
      taxType: taxType,
      gstApplicable: gstApplicable,
      total: payload.total || finalTotal,
      roundingApplied: payload.roundingApplied || false,
      signatureSaved: !!signatureBase64,
      projectId: validatedProjectId,
      projectName: payload.projectName || null,
      budgetUpdated: !!validatedProjectId
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error creating sales invoice:", err);
    
    // Handle duplicate invoice number error
    if (err.code === 'ER_DUP_ENTRY' || err.message.includes('Duplicate entry')) {
      if (err.message.includes('invoice_sequences.unique_project_prefix')) {
        res.status(400).json({ 
          message: "Invoice sequence already exists for this project and prefix. Please try again."
        });
      } else {
        res.status(400).json({ 
          message: "Invoice number already exists. Please use a different number."
        });
      }
    } else if (err.message && err.message.includes('exceeds project budget')) {
      res.status(400).json({ 
        message: err.message,
        invoiceAmount: err.invoiceAmount,
        projectBudget: err.projectBudget,
        exceedsBy: err.exceedsBy
      });
    } else {
      res.status(500).json({ 
        message: "Error creating sales invoice", 
        error: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
      });
    }
  } finally {
    conn.release();
  }
};

// Update SALES invoice - FIXED
exports.update = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'sales'", 
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Sales invoice not found" });
    }

    const oldInvoice = rows[0];
    const payload = req.body;

    // Get GST applicability from payload (default to true if not specified)
    const gstApplicable = payload.gstApplicable !== false;
    const oldGstApplicable = oldInvoice.meta ? 
      (typeof oldInvoice.meta === 'string' ? 
        JSON.parse(oldInvoice.meta).gstApplicable !== false : 
        (oldInvoice.meta.gstApplicable !== false)) : true;

    // Get tax type based on GST applicability
    const taxType = gstApplicable ? (payload.taxType || 'sgst_cgst') : 'none';
    const oldTaxType = oldInvoice.meta ? 
      (typeof oldInvoice.meta === 'string' ? 
        (JSON.parse(oldInvoice.meta).taxType || 'sgst_cgst') : 
        (oldInvoice.meta.taxType || 'sgst_cgst')) : 'sgst_cgst';

    // Get proper project ID
    const validatedProjectId = getProjectIdForValidation(payload.projectId);

    // Track changes for history log
    const changes = {};
    
    // Compare basic fields
    if (oldInvoice.status !== payload.status) {
      changes.status = { from: oldInvoice.status, to: payload.status };
    }
    if (parseFloat(oldInvoice.total).toFixed(2) !== parseFloat(payload.total).toFixed(2)) {
      changes.total = { from: parseFloat(oldInvoice.total), to: parseFloat(payload.total) };
    }
    
    // Get current full invoice number for comparison
    const currentFullNumber = oldInvoice.invoice_number_generated || 
      `${oldInvoice.invoice_prefix || 'ICE/25-26/INV/'}${oldInvoice.invoiceNumber}`;
    
    // Parse old invoice meta to get original project budget
    let oldInvoiceMeta = {};
    if (oldInvoice.meta) {
      try {
        oldInvoiceMeta = typeof oldInvoice.meta === 'string' 
          ? JSON.parse(oldInvoice.meta) 
          : oldInvoice.meta;
      } catch (e) {
        console.error("Error parsing old invoice meta:", e);
      }
    }

    // Compare GST applicability changes
    if (oldGstApplicable !== gstApplicable) {
      changes.gstApplicable = { from: oldGstApplicable, to: gstApplicable };
    }

    // Compare tax type changes (only if GST is applicable)
    if (gstApplicable && oldGstApplicable && oldTaxType !== taxType) {
      changes.taxType = { from: oldTaxType, to: taxType };
    }

    // ==================== INVOICE NUMBER HANDLING FOR UPDATE ====================
    let newGeneratedNumber = oldInvoice.invoice_number_generated;
    let newInvoiceSequence = oldInvoice.invoice_sequence;
    let isManualInvoice = oldInvoice.is_manual_invoice;
    let originalSequence = oldInvoice.original_sequence;
    let sequenceStr = oldInvoice.invoiceNumber; // Current sequence string
    let invoiceNumberChanged = false;
    let invoicePrefix = payload.invoicePrefix || 'ICE/25-26/INV/';

    console.log("Current invoice number:", currentFullNumber);
    console.log("New invoice number from payload:", payload.manualInvoiceNumber);

    // Check if invoice number is being changed
    if (payload.manualInvoiceNumber && payload.manualInvoiceNumber !== currentFullNumber) {
      console.log("Invoice number changed from", currentFullNumber, "to", payload.manualInvoiceNumber);
      invoiceNumberChanged = true;
      
      // Parse the new invoice number
      const parsed = parseInvoiceNumber(payload.manualInvoiceNumber, invoicePrefix);
      
      if (!parsed.number) {
        await conn.rollback();
        return res.status(400).json({ message: "Invalid invoice number format" });
      }
      
      // Use the actual prefix from the parsed number
      invoicePrefix = parsed.prefix;
      newGeneratedNumber = parsed.number;
      
      // CRITICAL FIX: Validate uniqueness with proper project ID handling
      if (newGeneratedNumber !== currentFullNumber) {
        const isValid = await validateInvoiceNumber(
          conn,
          newGeneratedNumber,
          validatedProjectId,
          req.params.id // Exclude current invoice
        );
        
        if (!isValid) {
          await conn.rollback();
          return res.status(400).json({
            message: `Invoice number "${newGeneratedNumber}" already exists ${validatedProjectId !== null ? 'for this project' : 'globally'}`,
            available: false,
            existingInvoice: true
          });
        }
      }
      
      newInvoiceSequence = parsed.sequence || 0;
      isManualInvoice = true;
      originalSequence = parsed.sequence || null;
      sequenceStr = parsed.sequenceStr;
      
      console.log('Updated invoice number details:', {
        newGeneratedNumber,
        invoicePrefix,
        newInvoiceSequence,
        sequenceStr,
        isManualInvoice,
        projectId: validatedProjectId
      });
      
      // Update sequence tracker if needed
      if (parsed.sequence && !isNaN(parsed.sequence)) {
        const [existing] = await conn.execute(
          'SELECT * FROM invoice_sequences WHERE project_id <=> ? AND prefix = ? AND invoice_type = ? FOR UPDATE',
          [validatedProjectId, invoicePrefix, 'sales']
        );
        
        if (existing.length === 0) {
          await conn.execute(
            'INSERT INTO invoice_sequences (project_id, prefix, invoice_type, last_sequence) VALUES (?, ?, ?, ?)',
            [validatedProjectId, invoicePrefix, 'sales', parsed.sequence]
          );
        } else if (parsed.sequence > existing[0].last_sequence) {
          await conn.execute(
            'UPDATE invoice_sequences SET last_sequence = ? WHERE project_id <=> ? AND prefix = ? AND invoice_type = ?',
            [parsed.sequence, validatedProjectId, invoicePrefix, 'sales']
          );
        }
      }
      
      // Track invoice number change
      changes.invoiceNumber = { 
        from: currentFullNumber, 
        to: newGeneratedNumber 
      };
      changes.isManualInvoice = { from: oldInvoice.is_manual_invoice, to: true };
      changes.sequenceString = { from: oldInvoice.invoiceNumber, to: sequenceStr };
    } else if (!payload.manualInvoiceNumber) {
      // Auto-generated mode - check if sequence is being changed
      const oldSequence = oldInvoice.invoiceNumber;
      const newSequence = payload.invoiceNumber ? payload.invoiceNumber.padStart(4, '0') : oldSequence;
      
      if (oldSequence !== newSequence) {
        invoiceNumberChanged = true;
        
        // Build full invoice number
        newGeneratedNumber = `${invoicePrefix}${newSequence}`;
        
        // Validate uniqueness
        const isValid = await validateInvoiceNumber(
          conn,
          newGeneratedNumber,
          validatedProjectId,
          req.params.id
        );
        
        if (!isValid) {
          await conn.rollback();
          return res.status(400).json({
            message: `Invoice number "${newGeneratedNumber}" already exists ${validatedProjectId !== null ? 'for this project' : 'globally'}`,
            available: false,
            existingInvoice: true
          });
        }
        
        // Update sequence
        const sequenceNum = parseInt(newSequence, 10);
        if (!isNaN(sequenceNum)) {
          newInvoiceSequence = sequenceNum;
          sequenceStr = newSequence;
          
          // Update sequence tracker
          const [existing] = await conn.execute(
            'SELECT * FROM invoice_sequences WHERE project_id <=> ? AND prefix = ? AND invoice_type = ? FOR UPDATE',
            [validatedProjectId, invoicePrefix, 'sales']
          );
          
          if (existing.length === 0) {
            await conn.execute(
              'INSERT INTO invoice_sequences (project_id, prefix, invoice_type, last_sequence) VALUES (?, ?, ?, ?)',
              [validatedProjectId, invoicePrefix, 'sales', sequenceNum]
            );
          } else if (sequenceNum > existing[0].last_sequence) {
            await conn.execute(
              'UPDATE invoice_sequences SET last_sequence = ? WHERE project_id <=> ? AND prefix = ? AND invoice_type = ?',
              [sequenceNum, validatedProjectId, invoicePrefix, 'sales']
            );
          }
        }
        
        changes.invoiceNumber = { 
          from: currentFullNumber, 
          to: newGeneratedNumber 
        };
        changes.sequenceString = { from: oldSequence, to: newSequence };
      }
    }

    // Project Budget Validation for Update - Use original project budget from invoice meta
    if (validatedProjectId !== null) {
      console.log("Checking project budget for project ID:", validatedProjectId);
      
      // Get the original project budget from invoice meta (stored during creation)
      const originalProjectBudget = oldInvoiceMeta.originalProjectBudget;
      
      if (originalProjectBudget !== undefined && originalProjectBudget !== null) {
        const projectBudget = parseFloat(originalProjectBudget);
        console.log("Original project budget from invoice:", projectBudget);
        
        if (!isNaN(projectBudget) && projectBudget > 0) {
          // Calculate new invoice total for validation
          const taxType = gstApplicable ? (payload.taxType || 'sgst_cgst') : 'none';

          // Calculate subtotal using the helper function
          const subtotal = payload.items.reduce((sum, item) => {
            return sum + calculateItemBaseAmount(item);
          }, 0);
          
          const discountValue = payload.discount && payload.discount.type === "percent" 
            ? (subtotal * payload.discount.value) / 100 
            : (payload.discount?.value || 0);
          
          const additionalChargesTotal = payload.additionalCharges?.reduce((sum, charge) => sum + charge.amount, 0) || 0;
          
          const taxable = subtotal - discountValue + additionalChargesTotal;
          const tcs = payload.applyTCS ? taxable * 0.01 : 0;
          
          // Calculate total tax based on GST applicability
          let totalTax = 0;
          let sgstTotal = 0;
          let cgstTotal = 0;
          let igstTotal = 0;

          if (gstApplicable) {
            payload.items.forEach(item => {
              const amounts = calculateItemAmounts(item, taxType, true);
              totalTax += amounts.taxAmount;
              sgstTotal += amounts.sgstAmount;
              cgstTotal += amounts.cgstAmount;
              igstTotal += amounts.igstAmount;
            });
          }

          // Apply rounding if enabled
          let calculatedTotal;
          if (gstApplicable) {
            calculatedTotal = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;
          } else {
            calculatedTotal = taxable + tcs; // No tax when GST is not applicable
          }
          
          const finalTotal = payload.roundingApplied ? Math.round(calculatedTotal) : calculatedTotal;
          
          console.log("New invoice total amount:", finalTotal, "Original project budget:", projectBudget);
          
          // Validate if updated invoice amount exceeds original project budget
          if (finalTotal > projectBudget) {
            await conn.rollback();
            return res.status(400).json({ 
              message: `Invoice amount (₹${finalTotal.toFixed(2)}) exceeds original project budget (₹${projectBudget.toFixed(2)})`,
              invoiceAmount: finalTotal,
              projectBudget: projectBudget,
              exceedsBy: finalTotal - projectBudget
            });
          }
          
          console.log("Updated invoice amount is within original project budget");
        }
      } else {
        console.log("No original project budget found in invoice meta, skipping budget validation");
      }
    } else {
      console.log("No project selected, skipping budget validation");
    }

    // Handle signature - convert to base64 if provided
    const signatureBase64 = handleSignature(payload.signature);
    
    if (payload.signature && !signatureBase64) {
      console.warn('Signature provided but not in base64 format. Signature will not be updated.');
    }

    // Track signature changes
    if (payload.signature && !oldInvoice.signature) {
      changes.signature = { from: 'No signature', to: 'Signature added' };
    } else if (!payload.signature && oldInvoice.signature) {
      changes.signature = { from: 'Had signature', to: 'Signature removed' };
    }

    // Format dates to YYYY-MM-DD for MySQL
    const formatDateForMySQL = (dateString) => {
      if (!dateString) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
        return dateString;
      }
      if (dateString.includes('T')) {
        return dateString.split('T')[0];
      }
      return new Date(dateString).toISOString().split('T')[0];
    };

    const formattedDate = formatDateForMySQL(payload.date);
    const formattedDueDate = formatDateForMySQL(payload.dueDate);
    const formattedPoDate = formatDateForMySQL(payload.poDate);

    // Calculate subtotal using the helper function
    const subtotal = payload.items.reduce((sum, item) => {
      return sum + calculateItemBaseAmount(item);
    }, 0);
    
    const discountValue = payload.discount && payload.discount.type === "percent" 
      ? (subtotal * payload.discount.value) / 100 
      : (payload.discount?.value || 0);
    
    const additionalChargesTotal = payload.additionalCharges?.reduce((sum, charge) => sum + charge.amount, 0) || 0;
    
    const taxable = subtotal - discountValue + additionalChargesTotal;
    const tcs = payload.applyTCS ? taxable * 0.01 : 0;
    
    // Calculate total tax based on GST applicability
    let totalTax = 0;
    let sgstTotal = 0;
    let cgstTotal = 0;
    let igstTotal = 0;

    if (gstApplicable) {
      payload.items.forEach(item => {
        const amounts = calculateItemAmounts(item, taxType, true);
        totalTax += amounts.taxAmount;
        sgstTotal += amounts.sgstAmount;
        cgstTotal += amounts.cgstAmount;
        igstTotal += amounts.igstAmount;
      });
    }
    
    // Apply rounding if enabled
    let calculatedTotal;
    if (gstApplicable) {
      calculatedTotal = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;
    } else {
      calculatedTotal = taxable + tcs; // No tax when GST is not applicable
    }
    
    const finalTotal = payload.roundingApplied ? Math.round(calculatedTotal) : calculatedTotal;

    // Track rounding changes
    const oldRoundingApplied = oldInvoiceMeta.roundingApplied || false;
    if (oldRoundingApplied !== (payload.roundingApplied || false)) {
      changes.roundingApplied = { from: oldRoundingApplied, to: payload.roundingApplied || false };
    }

    // Create meta object with tax type, GST applicability and project details
    const meta = {
      taxType: taxType,
      gstApplicable: gstApplicable,
      discount: payload.discount || { type: "flat", value: 0 },
      discountValue: discountValue,
      additionalCharges: payload.additionalCharges || [],
      additionalChargesTotal: additionalChargesTotal,
      applyTCS: payload.applyTCS || false,
      tcs: tcs,
      taxableAmount: taxable,
      sgstTotal: gstApplicable && taxType === 'sgst_cgst' ? sgstTotal : 0,
      cgstTotal: gstApplicable && taxType === 'sgst_cgst' ? cgstTotal : 0,
      igstTotal: gstApplicable && taxType === 'igst' ? igstTotal : 0,
      totalTax: totalTax,
      
      // Rounding information
      roundingApplied: payload.roundingApplied || false,
      originalTotal: payload.originalTotal || calculatedTotal,
      roundedTotal: payload.roundedTotal || finalTotal,
      roundingDifference: payload.roundingDifference || (payload.roundingApplied ? (finalTotal - calculatedTotal) : 0),
      
      // Project information (also stored in meta for easy access)
      projectId: validatedProjectId,
      projectName: payload.projectName || null,
      
      // Preserve the original project budget from the old invoice
      originalProjectBudget: oldInvoiceMeta.originalProjectBudget || null,
      invoiceCreatedAtBudget: oldInvoiceMeta.invoiceCreatedAtBudget || null,
      
      amountReceived: payload.amountReceived || 0,
      paymentMode: payload.paymentMode || "Cash",
      paymentTerms: payload.paymentTerms || "",
      bankDetails: payload.bankDetails || null,
      billingAddress: payload.billingAddress || "",
      shippingAddress: payload.shippingAddress || "",
      poNumber: payload.poNumber || "",
      ewayBillNumber: payload.ewayBillNumber || "",
      vendorCode: payload.vendorCode || "",
      poDate: formattedPoDate,
      
      // Invoice number information
      isManualInvoice: isManualInvoice,
      invoicePrefix: invoicePrefix,
      generatedInvoiceNumber: newGeneratedNumber
    };

    // Update main invoice record with project_id and new invoice number fields
    await conn.execute(
      `UPDATE invoices SET 
        invoice_prefix = ?,
        invoice_sequence = ?,
        invoice_number_generated = ?,
        is_manual_invoice = ?,
        original_sequence = ?,
        invoiceNumber = ?,
        date = ?, 
        dueDate = ?, 
        clientId = ?, 
        status = ?, 
        subTotal = ?, 
        tax = ?, 
        discount = ?, 
        total = ?, 
        notes = ?, 
        signature = ?, 
        meta = ?, 
        project_id = ?,
        updatedAt = NOW() 
      WHERE id = ? AND type = 'sales'`,
      [
        invoicePrefix,
        newInvoiceSequence,
        newGeneratedNumber,
        isManualInvoice,
        originalSequence,
        sequenceStr, // Store the sequence string
        formattedDate,
        formattedDueDate,
        payload.clientId,
        payload.status || "draft",
        subtotal,
        totalTax,
        payload.totalDiscountAmount || discountValue,
        payload.total || finalTotal,
        JSON.stringify(payload.notes || []),
        signatureBase64,
        JSON.stringify(meta),
        validatedProjectId,
        req.params.id,
      ]
    );

    // Update project budget after successful invoice update
    if (validatedProjectId !== null && oldInvoiceMeta.originalProjectBudget) {
      console.log("Updating project budget for project ID:", validatedProjectId);
      
      // Get current project details
      const [projects] = await conn.execute(
        "SELECT * FROM projects WHERE id = ?",
        [validatedProjectId]
      );
      
      if (projects.length > 0) {
        const project = projects[0];
        let projectMeta = {};
        
        // Parse existing meta_data
        if (project.meta_data) {
          try {
            projectMeta = typeof project.meta_data === 'string' 
              ? JSON.parse(project.meta_data) 
              : project.meta_data;
          } catch (e) {
            console.error("Error parsing project meta_data:", e);
          }
        }
        
        // Calculate the new budget amount
        // Restore old amount and deduct new amount
        const oldInvoiceTotal = parseFloat(oldInvoice.total);
        const budgetDifference = finalTotal - oldInvoiceTotal;
        
        // Get current budget and adjust
        const currentBudget = projectMeta.amount !== undefined ? parseFloat(projectMeta.amount) : oldInvoiceMeta.originalProjectBudget;
        const newBudgetAmount = currentBudget - budgetDifference;
        
        // Update project meta_data with new budget amount
        projectMeta.amount = newBudgetAmount;
        
        // Update the project in database
        await conn.execute(
          "UPDATE projects SET meta_data = ? WHERE id = ?",
          [JSON.stringify(projectMeta), validatedProjectId]
        );
        
        console.log(`Project budget updated: ₹${currentBudget.toFixed(2)} - (${finalTotal.toFixed(2)} - ${oldInvoiceTotal.toFixed(2)}) = ₹${newBudgetAmount.toFixed(2)}`);
        
        // Track budget changes
        changes.projectBudget = { 
          from: `₹${currentBudget.toFixed(2)}`, 
          to: `₹${newBudgetAmount.toFixed(2)}`,
          difference: `₹${budgetDifference.toFixed(2)}`
        };
      }
    }

    // Delete existing items and insert new ones
    await conn.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);

    // Track item changes
    const [oldItems] = await conn.execute(
      "SELECT COUNT(*) as count FROM invoice_items WHERE invoiceId = ?",
      [req.params.id]
    );
    const oldItemCount = oldItems[0].count;
    changes.items = {
      from: `${oldItemCount} items`,
      to: `${payload.items.length} items`
    };

    // Insert updated items
    for (const item of payload.items) {
      const amounts = calculateItemAmounts(item, taxType, gstApplicable);

      // Create item meta with tax information based on GST applicability
      const itemMeta = {
        sgst: gstApplicable && taxType === 'sgst_cgst' ? (item.sgst || 9) : 0,
        cgst: gstApplicable && taxType === 'sgst_cgst' ? (item.cgst || 9) : 0,
        igst: gstApplicable && taxType === 'igst' ? (item.igst || 18) : 0,
        sgstAmount: amounts.sgstAmount,
        cgstAmount: amounts.cgstAmount,
        igstAmount: amounts.igstAmount,
        taxableAmount: amounts.taxableAmount,
        percentageValue: item.percentageValue || null,
        isPercentageQty: item.isPercentageQty || false
      };

      // Store quantity as 0 if using percentage mode, otherwise use actual quantity
      const quantityToStore = item.isPercentageQty ? 0 : item.quantity;

      await conn.execute(
        `INSERT INTO invoice_items 
        (invoiceId, itemId, description, hsn, uom, quantity, rate, discount, tax, taxAmount, amount, meta) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.params.id,
          item.itemId || null,
          item.description,
          item.hsn || '',
          item.uom || '',
          quantityToStore,
          item.rate,
          item.discountAmount || 0,
          item.tax || 0,
          amounts.taxAmount,
          amounts.totalAmount,
          JSON.stringify(itemMeta)
        ]
      );
    }

    // Commit transaction FIRST
    await conn.commit();

    // THEN log the update action OUTSIDE the transaction
    let details = `Sales invoice updated to ${newGeneratedNumber}`;
    if (!gstApplicable) {
      details += ' (GST Exempt)';
    }
    if (invoiceNumberChanged) {
      details += ' - Invoice number changed';
    }
    if (Object.keys(changes).length > 0) {
      details += ` - ${Object.keys(changes).join(', ')} changed`;
    }

    logInvoiceAction(
      req.params.id,
      'updated',
      details,
      changes,
      req
    );

    res.json({ 
      message: "Sales invoice updated successfully",
      id: req.params.id,
      invoiceNumber: newGeneratedNumber,
      invoiceSequence: newInvoiceSequence,
      sequenceString: sequenceStr,
      isManualInvoice: isManualInvoice,
      taxType: taxType,
      gstApplicable: gstApplicable,
      total: payload.total || finalTotal,
      roundingApplied: payload.roundingApplied || false,
      signatureUpdated: !!signatureBase64,
      projectId: validatedProjectId,
      projectName: payload.projectName || null,
      budgetUpdated: validatedProjectId !== null
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error updating sales invoice:", err);
    
    // Handle duplicate invoice number error
    if (err.code === 'ER_DUP_ENTRY' || err.message.includes('Duplicate entry')) {
      res.status(400).json({ 
        message: "Invoice number already exists. Please use a different number.",
        error: err.message
      });
    } else if (err.message && err.message.includes('exceeds project budget')) {
      res.status(500).json({ 
        message: err.message,
        invoiceAmount: err.invoiceAmount,
        projectBudget: err.projectBudget,
        exceedsBy: err.exceedsBy
      });
    } else {
      res.status(500).json({ 
        message: "Error updating sales invoice", 
        error: err.message,
        sql: err.sql
      });
    }
  } finally {
    conn.release();
  }
};


// Delete SALES invoice - WITH LOGGING
exports.delete = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'sales'", 
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Sales invoice not found" });
    }

    const invoice = rows[0];

    // Parse invoice meta for project information
    let invoiceMeta = {};
    if (invoice.meta) {
      try {
        invoiceMeta = typeof invoice.meta === 'string' 
          ? JSON.parse(invoice.meta) 
          : invoice.meta;
      } catch (e) {
        console.error("Error parsing invoice meta:", e);
      }
    }

    // LOG THE DELETION ACTION BEFORE DELETING THE INVOICE
    const logData = {
      invoiceNumber: invoice.invoice_number_generated,
      invoiceSequence: invoice.invoice_sequence,
      isManualInvoice: invoice.is_manual_invoice,
      total: invoice.total,
      client: invoice.clientId,
      status: invoice.status,
      projectId: invoice.project_id,
      budgetRestored: !!invoice.project_id
    };

    // Restore project budget if invoice was associated with a project
    if (invoice.project_id && invoiceMeta.originalProjectBudget) {
      console.log("Restoring project budget for project ID:", invoice.project_id);
      
      // Get current project details
      const [projects] = await conn.execute(
        "SELECT * FROM projects WHERE id = ?",
        [invoice.project_id]
      );
      
      if (projects.length > 0) {
        const project = projects[0];
        let projectMeta = {};
        
        // Parse existing meta_data
        if (project.meta_data) {
          try {
            projectMeta = typeof project.meta_data === 'string' 
              ? JSON.parse(project.meta_data) 
              : project.meta_data;
          } catch (e) {
            console.error("Error parsing project meta_data:", e);
          }
        }
        
        // Restore budget by adding back the invoice amount
        const currentBudget = projectMeta.amount !== undefined ? parseFloat(projectMeta.amount) : 0;
        const invoiceAmount = parseFloat(invoice.total);
        const newBudgetAmount = currentBudget + invoiceAmount;
        
        // Update project meta_data with restored budget amount
        projectMeta.amount = newBudgetAmount;
        
        // Update the project in database
        await conn.execute(
          "UPDATE projects SET meta_data = ? WHERE id = ?",
          [JSON.stringify(projectMeta), invoice.project_id]
        );
        
        console.log(`Project budget restored: ₹${currentBudget.toFixed(2)} + ₹${invoiceAmount.toFixed(2)} = ₹${newBudgetAmount.toFixed(2)}`);
      }
    }

    // Delete items first
    await conn.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);
    
    // Delete invoice
    const [result] = await conn.execute(
      "DELETE FROM invoices WHERE id = ? AND type = 'sales'", 
      [req.params.id]
    );

    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Sales invoice not found" });
    }

    await conn.commit();

    // Log the deletion AFTER successful deletion but using the stored data
    logInvoiceAction(
      req.params.id, // We still pass the ID for reference, but it won't be in the database
      'deleted',
      `Sales invoice ${logData.invoiceNumber} deleted`,
      logData,
      req
    );

    res.json({ message: "Sales invoice deleted successfully" });
  } catch (err) {
    await conn.rollback();
    console.error("Error deleting sales invoice:", err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
};

// Update payment status for sales invoice - WITH LOGGING
exports.updatePaymentStatus = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'sales'", 
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Sales invoice not found" });
    }

    const oldInvoice = rows[0];
    const { amountReceived, status, paymentMode } = req.body;

    // Parse old meta
    let oldMeta = {};
    if (oldInvoice.meta) {
      try {
        oldMeta = typeof oldInvoice.meta === 'string' 
          ? JSON.parse(oldInvoice.meta) 
          : oldInvoice.meta;
      } catch (e) {
        console.error("Error parsing old invoice meta:", e);
      }
    }

    const changes = {};
    
    // Track amount received changes
    if (parseFloat(oldMeta.amountReceived || 0) !== parseFloat(amountReceived || 0)) {
      changes.amountReceived = { 
        from: parseFloat(oldMeta.amountReceived || 0), 
        to: parseFloat(amountReceived || 0) 
      };
    }

    // Track status changes
    if (oldInvoice.status !== status) {
      changes.status = { from: oldInvoice.status, to: status };
    }

    // Track payment mode changes
    const oldPaymentMode = oldMeta.paymentMode || "Cash";
    if (oldPaymentMode !== (paymentMode || "Cash")) {
      changes.paymentMode = { from: oldPaymentMode, to: paymentMode || "Cash" };
    }

    // Update meta with new payment information
    const updatedMeta = {
      ...oldMeta,
      amountReceived: parseFloat(amountReceived || 0),
      paymentMode: paymentMode || oldMeta.paymentMode || "Cash"
    };

    await conn.execute(
      `UPDATE invoices SET 
        status = ?, 
        meta = ?, 
        updatedAt = NOW() 
      WHERE id = ? AND type = 'sales'`,
      [status, JSON.stringify(updatedMeta), req.params.id]
    );

    await conn.commit();

    // Log payment status update
    logInvoiceAction(
      req.params.id,
      'payment_updated',
      `Payment status updated for sales invoice ${oldInvoice.invoice_number_generated}`,
      changes,
      req
    );

    res.json({ 
      message: "Payment status updated successfully",
      invoiceId: req.params.id,
      status: status,
      amountReceived: amountReceived,
      paymentMode: paymentMode || "Cash"
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error updating payment status:", err);
    res.status(500).json({ 
      message: "Error updating payment status", 
      error: err.message
    });
  } finally {
    conn.release();
  }
};

// Remove signature from an invoice - WITH LOGGING
exports.removeSignature = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      "SELECT id, invoice_number_generated FROM invoices WHERE id = ? AND type = 'sales'",
      [req.params.id]
    );
    
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Invoice not found" });
    }

    const invoice = rows[0];

    await conn.execute(
      "UPDATE invoices SET signature = NULL WHERE id = ?",
      [req.params.id]
    );

    await conn.commit();

    // Log signature removal
    logInvoiceAction(
      req.params.id,
      'signature_removed',
      `Signature removed from sales invoice ${invoice.invoice_number_generated}`,
      {
        signature: { from: 'Had signature', to: 'No signature' }
      },
      req
    );

    res.json({ 
      message: "Signature removed successfully",
      id: req.params.id
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error removing signature:", err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
};

// Migration script to add originalProjectBudget to existing invoices
exports.migrateInvoiceBudgets = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    // Get all sales invoices with projects
    const [invoices] = await conn.execute(`
      SELECT i.*, p.meta_data as project_meta_data 
      FROM invoices i 
      LEFT JOIN projects p ON i.project_id = p.id 
      WHERE i.type = 'sales' AND i.project_id IS NOT NULL
    `);

    let updatedCount = 0;

    for (const invoice of invoices) {
      let invoiceMeta = {};
      
      // Parse existing invoice meta
      if (invoice.meta) {
        try {
          invoiceMeta = typeof invoice.meta === 'string' 
            ? JSON.parse(invoice.meta) 
            : invoice.meta;
        } catch (e) {
          console.error("Error parsing invoice meta:", e);
        }
      }

      // If originalProjectBudget doesn't exist, calculate and add it
      if (!invoiceMeta.originalProjectBudget && invoice.project_meta_data) {
        try {
          const projectMeta = typeof invoice.project_meta_data === 'string' 
            ? JSON.parse(invoice.project_meta_data) 
            : invoice.project_meta_data;
          
          if (projectMeta.amount) {
            // Calculate original budget by adding back all invoices for this project
            const [projectInvoices] = await conn.execute(
              "SELECT SUM(total) as total_invoiced FROM invoices WHERE project_id = ? AND type = 'sales'",
              [invoice.project_id]
            );
            
            const totalInvoiced = parseFloat(projectInvoices[0].total_invoiced) || 0;
            const currentBudget = parseFloat(projectMeta.amount);
            const originalBudget = totalInvoiced + currentBudget;
            
            invoiceMeta.originalProjectBudget = originalBudget;
            invoiceMeta.invoiceCreatedAtBudget = originalBudget;
            
            // Update the invoice
            await conn.execute(
              "UPDATE invoices SET meta = ? WHERE id = ?",
              [JSON.stringify(invoiceMeta), invoice.id]
            );
            
            updatedCount++;
            console.log(`Updated invoice ${invoice.id} with original budget: ${originalBudget}`);
          }
        } catch (e) {
          console.error("Error processing invoice:", invoice.id, e);
        }
      }
    }

    await conn.commit();

    res.json({ 
      message: `Migration completed. Updated ${updatedCount} invoices.`
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error migrating invoice budgets:", err);
    res.status(500).json({ 
      message: "Error migrating invoice budgets", 
      error: err.message 
    });
  } finally {
    conn.release();
  }
};

// Get balance (paid vs unpaid) for SALES invoices
exports.balance = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'sales'", 
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Sales invoice not found" });

    const invoice = rows[0];

    const [payments] = await db.execute("SELECT * FROM payments WHERE invoiceId = ?", [invoice.id]);
    const paid = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

    const balance = +(parseFloat(invoice.total) - paid).toFixed(2);

    res.json({ invoiceId: invoice.id, total: invoice.total, paid: +paid.toFixed(2), balance });
  } catch (err) {
    console.error("Error calculating balance for sales invoice:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get signature for an invoice
exports.getSignature = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT signature FROM invoices WHERE id = ? AND type = 'sales'",
      [req.params.id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const invoice = rows[0];
    
    if (!invoice.signature) {
      return res.status(404).json({ message: "No signature found for this invoice" });
    }

    // Return the base64 signature
    res.json({ 
      signature: invoice.signature,
      hasSignature: true
    });
  } catch (err) {
    console.error("Error fetching invoice signature:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get sales invoice stats
exports.getSalesInvoiceStats = async (req, res) => {
  try {
    const [totalCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'sales'"
    );
    
    const [totalAmount] = await db.execute(
      "SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE type = 'sales'"
    );
    
    const [paidCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'sales' AND status = 'paid'"
    );
    
    const [draftCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'sales' AND status = 'draft'"
    );

    res.json({
      totalSalesInvoices: totalCount[0].count,
      totalAmount: totalAmount[0].total,
      paidSalesInvoices: paidCount[0].count,
      draftSalesInvoices: draftCount[0].count
    });
  } catch (err) {
    console.error("Error fetching sales invoice stats:", err);
    res.status(500).json({ message: "Database error" });
  }
};

exports.getHistory = async (req, res) => {
  try {
    const [logs] = await db.execute(
      `SELECT * FROM invoice_history 
       WHERE invoiceId = ? 
       ORDER BY createdAt DESC`,
      [req.params.id]
    );

    // Parse JSON changes field
    const parsedLogs = logs.map(log => ({
      ...log,
      changes: log.changes ? (typeof log.changes === 'string' ? JSON.parse(log.changes) : log.changes) : {}
    }));

    res.json(parsedLogs);
  } catch (err) {
    console.error("Error fetching invoice history:", err);
    res.status(500).json({ message: "Database error" });
  }
};