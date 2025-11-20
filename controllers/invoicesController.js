const db = require("../config/db");

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

// Helper function to calculate all item amounts with IGST support
function calculateItemAmounts(item, taxType = 'sgst_cgst') {
  const baseAmount = calculateItemBaseAmount(item);
  const discountAmount = item.discount ? (baseAmount * item.discount) / 100 : 0;
  const taxableAmount = baseAmount - discountAmount;
  const taxAmount = item.tax ? (taxableAmount * item.tax) / 100 : 0;
  
  // Calculate taxes based on tax type
  let sgstAmount = 0;
  let cgstAmount = 0;
  let igstAmount = 0;

  if (taxType === 'sgst_cgst') {
    sgstAmount = (taxableAmount * (item.sgst || 9)) / 100;
    cgstAmount = (taxableAmount * (item.cgst || 9)) / 100;
  } else {
    igstAmount = (taxableAmount * (item.igst || 18)) / 100;
  }

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
      const [items] = await db.execute(
        "SELECT * FROM invoice_items WHERE invoiceId = ?",
        [inv.id]
      );
      inv.items = items;

      // Parse meta data for project information
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

    // Extract tax type from meta
    const taxType = invoice.meta.taxType || 'sgst_cgst';

    const [client] = await db.execute(
      "SELECT * FROM clients WHERE id = ?",
      [invoice.clientId]
    );
    invoice.client = client[0] || null;

    const [items] = await db.execute(
      "SELECT * FROM invoice_items WHERE invoiceId = ?",
      [invoice.id]
    );
    
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
        if (typeof item.meta === 'object' && item.meta !== null) {
          item.sgst = item.meta.sgst || 9;
          item.cgst = item.meta.cgst || 9;
          item.igst = item.meta.igst || 18;
          item.sgstAmount = item.meta.sgstAmount || 0;
          item.cgstAmount = item.meta.cgstAmount || 0;
          item.igstAmount = item.meta.igstAmount || 0;
          item.percentageValue = item.meta.percentageValue || null;
          item.isPercentageQty = item.meta.isPercentageQty || false;
        }
      } else {
        item.meta = {};
      }
      return item;
    });

    // Add project information from meta if available
    if (invoice.meta.projectId) {
      invoice.projectId = invoice.meta.projectId;
      invoice.projectName = invoice.meta.projectName || invoice.projectName;
    }

    // Add tax type to invoice response
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
      const [items] = await db.execute(
        "SELECT * FROM invoice_items WHERE invoiceId = ?",
        [inv.id]
      );
      
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
          if (typeof item.meta === 'object' && item.meta !== null) {
            item.sgst = item.meta.sgst || 9;
            item.cgst = item.meta.cgst || 9;
            item.igst = item.meta.igst || 18;
            item.sgstAmount = item.meta.sgstAmount || 0;
            item.cgstAmount = item.meta.cgstAmount || 0;
            item.igstAmount = item.meta.igstAmount || 0;
            item.percentageValue = item.meta.percentageValue || null;
            item.isPercentageQty = item.meta.isPercentageQty || false;
          }
        } else {
          item.meta = {};
        }
        return item;
      });

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

// Create SALES invoice with items and project details
exports.create = async (req, res) => {
  const payload = req.body;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    console.log("Creating sales invoice with project ID:", payload.projectId);

    let originalProjectBudget = null;
    let currentProjectBudget = null;

    // NEW: Project Budget Validation
    if (payload.projectId) {
      console.log("Checking project budget for project ID:", payload.projectId);
      
      // Get project details with meta_data
      const [projects] = await conn.execute(
        "SELECT * FROM projects WHERE id = ?",
        [payload.projectId]
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
          const taxType = payload.taxType || 'sgst_cgst';
          
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
          
          // Calculate total tax, SGST, CGST, and IGST from items based on tax type
          let totalTax = 0;
          let sgstTotal = 0;
          let cgstTotal = 0;
          let igstTotal = 0;

          payload.items.forEach(item => {
            const amounts = calculateItemAmounts(item, taxType);
            totalTax += amounts.taxAmount;
            sgstTotal += amounts.sgstAmount;
            cgstTotal += amounts.cgstAmount;
            igstTotal += amounts.igstAmount;
          });

          // Apply rounding if enabled
          const calculatedTotal = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;
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

    // Continue with existing invoice creation logic...
    const taxType = payload.taxType || 'sgst_cgst';

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
    
    // Calculate total tax, SGST, CGST, and IGST from items based on tax type
    let totalTax = 0;
    let sgstTotal = 0;
    let cgstTotal = 0;
    let igstTotal = 0;

    payload.items.forEach(item => {
      const amounts = calculateItemAmounts(item, taxType);
      totalTax += amounts.taxAmount;
      sgstTotal += amounts.sgstAmount;
      cgstTotal += amounts.cgstAmount;
      igstTotal += amounts.igstAmount;
    });

    // Apply rounding if enabled
    const calculatedTotal = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;
    const finalTotal = payload.roundingApplied ? Math.round(calculatedTotal) : calculatedTotal;

    // Create meta object for additional fields with tax type and project details
    const meta = {
      taxType: taxType,
      discount: payload.discount || { type: "flat", value: 0 },
      discountValue: discountValue,
      additionalCharges: payload.additionalCharges || [],
      additionalChargesTotal: additionalChargesTotal,
      applyTCS: payload.applyTCS || false,
      tcs: tcs,
      taxableAmount: taxable,
      sgstTotal: taxType === 'sgst_cgst' ? sgstTotal : 0,
      cgstTotal: taxType === 'sgst_cgst' ? cgstTotal : 0,
      igstTotal: taxType === 'igst' ? igstTotal : 0,
      totalTax: totalTax,
      
      // Rounding information
      roundingApplied: payload.roundingApplied || false,
      originalTotal: payload.originalTotal || calculatedTotal,
      roundedTotal: payload.roundedTotal || finalTotal,
      roundingDifference: payload.roundingDifference || (payload.roundingApplied ? (finalTotal - calculatedTotal) : 0),
      
      // Project information (also stored in meta for easy access)
      projectId: payload.projectId || null,
      projectName: payload.projectName || null,
      
      // NEW: Store original project budget for future validation during updates
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
      poDate: payload.poDate || null
    };

    const [result] = await conn.execute(
      `INSERT INTO invoices 
      (invoiceNumber, date, dueDate, clientId, status, subTotal, tax, discount, total, notes, signature, type, meta, project_id, createdAt, updatedAt) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        payload.invoiceNumber,
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
        payload.projectId || null
      ]
    );

    const invoiceId = result.insertId;

    // NEW: Update project budget after successful invoice creation
    if (payload.projectId && currentProjectBudget !== null) {
      console.log("Updating project budget for project ID:", payload.projectId);
      
      // Get project details again to ensure we have latest data
      const [projects] = await conn.execute(
        "SELECT * FROM projects WHERE id = ?",
        [payload.projectId]
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
          [JSON.stringify(projectMeta), payload.projectId]
        );
        
        console.log(`Project budget updated: ₹${currentProjectBudget.toFixed(2)} -> ₹${newBudgetAmount.toFixed(2)}`);
      }
    }

    // Insert items with correct amount calculations
    for (const item of payload.items) {
      const amounts = calculateItemAmounts(item, taxType);

      // Create item meta with tax information based on tax type
      const itemMeta = {
        sgst: taxType === 'sgst_cgst' ? (item.sgst || 9) : 0,
        cgst: taxType === 'sgst_cgst' ? (item.cgst || 9) : 0,
        igst: taxType === 'igst' ? (item.igst || 18) : 0,
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
        (invoiceId, description, hsn, uom, quantity, rate, discount, tax, taxAmount, amount, meta) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId,
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

    await conn.commit();

    res.status(201).json({ 
      message: "Sales invoice created", 
      id: invoiceId,
      invoiceNumber: payload.invoiceNumber,
      taxType: taxType,
      total: payload.total || finalTotal,
      roundingApplied: payload.roundingApplied || false,
      signatureSaved: !!signatureBase64,
      projectId: payload.projectId || null,
      projectName: payload.projectName || null,
      budgetUpdated: !!payload.projectId
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error creating sales invoice:", err);
    
    // Check if it's a budget validation error
    if (err.message && err.message.includes('exceeds project budget')) {
      res.status(400).json({ 
        message: err.message,
        invoiceAmount: err.invoiceAmount,
        projectBudget: err.projectBudget,
        exceedsBy: err.exceedsBy
      });
    } else {
      res.status(500).json({ 
        message: "Error creating sales invoice", 
        error: err.message 
      });
    }
  } finally {
    conn.release();
  }
};

// Update SALES invoice with project details
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

    // Get tax type from payload
    const taxType = payload.taxType || 'sgst_cgst';

    // NEW: Project Budget Validation for Update - Use original project budget from invoice meta
    if (payload.projectId) {
      console.log("Checking project budget for project ID:", payload.projectId);
      
      // Get the original project budget from invoice meta (stored during creation)
      const originalProjectBudget = oldInvoiceMeta.originalProjectBudget;
      
      if (originalProjectBudget !== undefined && originalProjectBudget !== null) {
        const projectBudget = parseFloat(originalProjectBudget);
        console.log("Original project budget from invoice:", projectBudget);
        
        if (!isNaN(projectBudget) && projectBudget > 0) {
          // Calculate new invoice total for validation
          const taxType = payload.taxType || 'sgst_cgst';
          
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
          
          // Calculate total tax, SGST, CGST, and IGST from items based on tax type
          let totalTax = 0;
          let sgstTotal = 0;
          let cgstTotal = 0;
          let igstTotal = 0;

          payload.items.forEach(item => {
            const amounts = calculateItemAmounts(item, taxType);
            totalTax += amounts.taxAmount;
            sgstTotal += amounts.sgstAmount;
            cgstTotal += amounts.cgstAmount;
            igstTotal += amounts.igstAmount;
          });

          // Apply rounding if enabled
          const calculatedTotal = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;
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
    
    // Calculate total tax, SGST, CGST, and IGST from items based on tax type
    let totalTax = 0;
    let sgstTotal = 0;
    let cgstTotal = 0;
    let igstTotal = 0;

    payload.items.forEach(item => {
      const amounts = calculateItemAmounts(item, taxType);
      totalTax += amounts.taxAmount;
      sgstTotal += amounts.sgstAmount;
      cgstTotal += amounts.cgstAmount;
      igstTotal += amounts.igstAmount;
    });
    
    // Apply rounding if enabled
    const calculatedTotal = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;
    const finalTotal = payload.roundingApplied ? Math.round(calculatedTotal) : calculatedTotal;

    // Create meta object with tax type and project details
    const meta = {
      taxType: taxType,
      discount: payload.discount || { type: "flat", value: 0 },
      discountValue: discountValue,
      additionalCharges: payload.additionalCharges || [],
      additionalChargesTotal: additionalChargesTotal,
      applyTCS: payload.applyTCS || false,
      tcs: tcs,
      taxableAmount: taxable,
      sgstTotal: taxType === 'sgst_cgst' ? sgstTotal : 0,
      cgstTotal: taxType === 'sgst_cgst' ? cgstTotal : 0,
      igstTotal: taxType === 'igst' ? igstTotal : 0,
      totalTax: totalTax,
      
      // Rounding information
      roundingApplied: payload.roundingApplied || false,
      originalTotal: payload.originalTotal || calculatedTotal,
      roundedTotal: payload.roundedTotal || finalTotal,
      roundingDifference: payload.roundingDifference || (payload.roundingApplied ? (finalTotal - calculatedTotal) : 0),
      
      // Project information (also stored in meta for easy access)
      projectId: payload.projectId || null,
      projectName: payload.projectName || null,
      
      // NEW: Preserve the original project budget from the old invoice
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
      poDate: formattedPoDate
    };

    // Update main invoice record with project_id
    await conn.execute(
      `UPDATE invoices SET 
        invoiceNumber=?, 
        date=?, 
        dueDate=?, 
        clientId=?, 
        status=?, 
        subTotal=?, 
        tax=?, 
        discount=?, 
        total=?, 
        notes=?, 
        signature=?, 
        meta=?, 
        project_id=?,
        updatedAt=NOW() 
      WHERE id=? AND type='sales'`,
      [
        payload.invoiceNumber,
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
        payload.projectId || null,
        req.params.id,
      ]
    );

    // NEW: Update project budget after successful invoice update
    if (payload.projectId && oldInvoiceMeta.originalProjectBudget) {
      console.log("Updating project budget for project ID:", payload.projectId);
      
      // Get current project details
      const [projects] = await conn.execute(
        "SELECT * FROM projects WHERE id = ?",
        [payload.projectId]
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
          [JSON.stringify(projectMeta), payload.projectId]
        );
        
        console.log(`Project budget updated: ₹${currentBudget.toFixed(2)} - (${finalTotal.toFixed(2)} - ${oldInvoiceTotal.toFixed(2)}) = ₹${newBudgetAmount.toFixed(2)}`);
      }
    }

    // Delete existing items and insert new ones
    await conn.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);

    // Insert updated items
    for (const item of payload.items) {
      const amounts = calculateItemAmounts(item, taxType);

      // Create item meta with tax information based on tax type
      const itemMeta = {
        sgst: taxType === 'sgst_cgst' ? (item.sgst || 9) : 0,
        cgst: taxType === 'sgst_cgst' ? (item.cgst || 9) : 0,
        igst: taxType === 'igst' ? (item.igst || 18) : 0,
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
        (invoiceId, description, hsn, uom, quantity, rate, discount, tax, taxAmount, amount, meta) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.params.id,
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

    await conn.commit();

    res.json({ 
      message: "Sales invoice updated successfully",
      id: req.params.id,
      invoiceNumber: payload.invoiceNumber,
      taxType: taxType,
      total: payload.total || finalTotal,
      roundingApplied: payload.roundingApplied || false,
      signatureUpdated: !!signatureBase64,
      projectId: payload.projectId || null,
      projectName: payload.projectName || null,
      budgetUpdated: !!payload.projectId
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error updating sales invoice:", err);
    
    // Check if it's a budget validation error
    if (err.message && err.message.includes('exceeds project budget')) {
      res.status(400).json({ 
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

// Delete SALES invoice
exports.delete = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'sales'", 
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Sales invoice not found" });

    await db.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);
    const [result] = await db.execute(
      "DELETE FROM invoices WHERE id = ? AND type = 'sales'", 
      [req.params.id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: "Sales invoice not found" });

    res.json({ message: "Sales invoice deleted" });
  } catch (err) {
    console.error("Error deleting sales invoice:", err);
    res.status(500).json({ message: "Database error" });
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

// Remove signature from an invoice
exports.removeSignature = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      "SELECT id FROM invoices WHERE id = ? AND type = 'sales'",
      [req.params.id]
    );
    
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Invoice not found" });
    }

    await conn.execute(
      "UPDATE invoices SET signature = NULL WHERE id = ?",
      [req.params.id]
    );

    await conn.commit();

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