const db = require("../config/db");
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

// Helper function to calculate item base amount
function calculateItemBaseAmount(item) {
  return item.quantity * item.rate;
}

// Helper functions for tax calculation
const isTamilNaduPincode = (pincode) => {
  if (!pincode) return false;
  const pincodeStr = pincode.toString().trim();
  return pincodeStr.startsWith('6');
};

const extractPincode = (address) => {
  if (!address) return null;
  const pincodeMatch = address.match(/\b\d{6}\b/);
  return pincodeMatch ? pincodeMatch[0] : null;
};

// Helper function to get prefix by invoice type
const getPrefixByType = (type) => {
  switch(type) {
    case 'sales': return 'ICE/25-26/INV/';
    case 'purchase_order': return 'ICE/25-26/PO/';
    case 'purchase': return 'ICE/25-26/PI/';
    case 'debit': return 'ICE/25-26/DN/';
    case 'credit': return 'ICE/25-26/CN/';
    case 'proforma': return 'ICE/25-26/PRO/';
    case 'delivery_challan': return 'ICE/25-26/DC/';
    default: return 'ICE/25-26/INV/';
  }
};

// Updated helper function for purchase order calculations with tax type
function calculateItemAmounts(item, taxType = 'sgst_cgst') {
  const baseAmount = calculateItemBaseAmount(item);
  const discountAmount = item.discount ? (baseAmount * item.discount) / 100 : 0;
  const taxableAmount = baseAmount - discountAmount;
  
  // Calculate taxes based on tax type
  let taxAmount = 0;
  let sgstAmount = 0;
  let cgstAmount = 0;
  let igstAmount = 0;

  if (taxType === 'sgst_cgst') {
    // For SGST/CGST, use individual tax rates
    sgstAmount = (taxableAmount * (item.sgst || 9)) / 100;
    cgstAmount = (taxableAmount * (item.cgst || 9)) / 100;
    taxAmount = sgstAmount + cgstAmount;
  } else {
    // For IGST, use the single tax rate
    igstAmount = (taxableAmount * (item.igst || 18)) / 100;
    taxAmount = igstAmount;
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

// Helper function to log purchase order actions
const logPurchaseOrderAction = async (orderId, action, details, changes = {}, req = null) => {
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
          orderId,
          action,
          userId,
          userName,
          JSON.stringify(changes),
          details,
          ipAddress,
          userAgent
        ]
      );
      
      console.log(`📝 Purchase order history created for action: ${action} by user: ${userName}`);
    } catch (err) {
      console.error("❌ Error logging purchase order action:", err);
    }
  });
};

// Helper function to parse invoice number with type-based prefix
const parseInvoiceNumberWithType = (fullNumber, invoiceType = 'purchase_order') => {
  if (!fullNumber) return { sequence: null, number: null, prefix: getPrefixByType(invoiceType) };
  
  const prefix = getPrefixByType(invoiceType);
  const lastSlashIndex = fullNumber.lastIndexOf('/');
  let actualPrefix = prefix;
  let sequenceStr = fullNumber;
  
  if (lastSlashIndex !== -1) {
    actualPrefix = fullNumber.substring(0, lastSlashIndex + 1);
    sequenceStr = fullNumber.substring(lastSlashIndex + 1);
  }
  
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
    prefix: actualPrefix
  };
};

// Updated validateInvoiceNumber helper function
const validateInvoiceNumber = async (conn, invoiceNumber, projectId = null, excludeId = null, invoiceType = 'purchase_order') => {
  try {
    console.log('Validating invoice number:', {
      invoiceNumber,
      projectId,
      excludeId,
      invoiceType
    });
    
    let query = `
      SELECT COUNT(*) as count 
      FROM invoices 
      WHERE invoice_number_generated = ? 
        AND type = ?
    `;
    
    const params = [invoiceNumber, invoiceType];
    
    if (projectId === null) {
      query += ' AND project_id IS NULL';
    } else {
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

// Get next purchase order number
exports.getNextPurchaseOrderNumber = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    const { projectId, prefix = 'ICE/25-26/PO/', invoiceType = 'purchase_order' } = req.query;
    
    // Get current max sequence
    const [sequences] = await conn.execute(
      'SELECT last_sequence FROM invoice_sequences WHERE project_id = ? AND prefix = ? AND invoice_type = ?',
      [projectId || null, prefix, invoiceType]
    );
    
    let nextSequence = 1;
    if (sequences.length > 0) {
      nextSequence = sequences[0].last_sequence + 1;
    } else {
      // Check if there's any existing purchase order for this project/global
      let query = `
        SELECT MAX(invoice_sequence) as max_sequence 
        FROM invoices 
        WHERE invoice_prefix = ? 
          AND type = ?
      `;
      
      const params = [prefix, invoiceType];
      
      if (projectId) {
        query += ' AND project_id = ?';
        params.push(projectId);
      } else {
        query += ' AND project_id IS NULL';
      }
      
      const [orders] = await conn.execute(query, params);
      
      if (orders[0].max_sequence) {
        nextSequence = orders[0].max_sequence + 1;
      }
    }
    
    conn.release();
    
    res.json({
      success: true,
      nextSequence,
      nextInvoiceNumber: `${prefix}${nextSequence.toString().padStart(4, '0')}`,
      projectId: projectId || null,
      prefix
    });
  } catch (error) {
    if (conn) conn.release();
    console.error('Error getting next purchase order number:', error);
    res.status(500).json({ 
      success: false,
      message: 'Database error' 
    });
  }
};

// Check purchase order number availability
exports.checkPurchaseOrderNumber = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    const { invoiceNumber, projectId, invoiceType = 'purchase_order' } = req.query;
    
    if (!invoiceNumber) {
      return res.status(400).json({ 
        success: false,
        message: 'Invoice number is required' 
      });
    }
    
    let parsedProjectId = null;
    if (projectId !== undefined && projectId !== null && projectId !== '') {
      if (projectId === 'null' || projectId === 'undefined') {
        parsedProjectId = null;
      } else {
        parsedProjectId = parseInt(projectId);
        if (isNaN(parsedProjectId)) {
          parsedProjectId = null;
        }
      }
    }
    
    console.log('Checking purchase order number:', {
      invoiceNumber,
      projectId,
      parsedProjectId,
      invoiceType
    });
    
    // Check if the number already exists for purchase orders
    const isValid = await validateInvoiceNumber(
      conn,
      invoiceNumber,
      parsedProjectId,
      null,
      invoiceType
    );
    
    conn.release();
    
    res.json({
      success: true,
      available: isValid,
      invoiceNumber,
      projectId: parsedProjectId
    });
  } catch (error) {
    if (conn) conn.release();
    console.error('Error checking purchase order number:', error);
    res.status(500).json({ 
      success: false,
      message: 'Database error' 
    });
  }
};

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/purchase-orders/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    if (file.mimetype === 'application/pdf') {
      cb(null, 'po-pdf-' + uniqueSuffix + path.extname(file.originalname));
    } else {
      cb(null, 'po-excel-' + uniqueSuffix + path.extname(file.originalname));
    }
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || 
        file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.mimetype === 'application/vnd.ms-excel') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and Excel files are allowed'), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

exports.upload = upload;

// Helper function to find or create supplier
async function findOrCreateSupplier(supplierName, gstin, pan, conn = db) {
  if (!supplierName) return null;

  try {
    // Try to find existing supplier
    const [existingSuppliers] = await conn.execute(
      'SELECT id FROM parties WHERE partyName = ? AND (partyType = "supplier" OR partyType IS NULL)',
      [supplierName.trim()]
    );

    if (existingSuppliers.length > 0) {
      return existingSuppliers[0].id;
    }

    // Create new supplier
    const [result] = await conn.execute(
      'INSERT INTO parties (partyName, partyType, gstin, pan, createdAt, updatedAt) VALUES (?, "supplier", ?, ?, NOW(), NOW())',
      [supplierName.trim(), gstin || null, pan || null]
    );

    return result.insertId;
  } catch (error) {
    console.error('Error finding/creating supplier:', error);
    return null;
  }
}

// Helper function to find or create supplier with address
async function findOrCreateSupplierWithAddress(supplierName, gstin, pan, billingAddress, shippingAddress, mobile = '', email = '', conn = db) {
  if (!supplierName) {
    console.error('Supplier name is required');
    return null;
  }

  try {
    const trimmedName = supplierName.toString().trim();
    
    // Try to find existing supplier by name (case insensitive) or GSTIN
    let [existingSuppliers] = await conn.execute(
      `SELECT id FROM parties 
       WHERE (LOWER(partyName) = LOWER(?) OR gstin = ?) 
       AND (partyType = 'Supplier' OR partyType IS NULL OR partyType = '') 
       LIMIT 1`,
      [trimmedName, gstin]
    );

    if (existingSuppliers.length > 0) {
      console.log(`Found existing supplier: ${trimmedName}, ID: ${existingSuppliers[0].id}`);
      
      const supplierId = existingSuppliers[0].id;
      try {
        await conn.execute(
          `UPDATE parties SET 
           billingAddress = COALESCE(?, billingAddress), 
           shippingAddress = COALESCE(?, shippingAddress), 
           gstin = COALESCE(?, gstin), 
           pan = COALESCE(?, pan), 
           updatedAt = NOW() 
           WHERE id = ?`,
          [billingAddress, shippingAddress, gstin, pan, supplierId]
        );
      } catch (updateError) {
        console.error('Error updating supplier:', updateError);
      }
      return supplierId;
    }

    // Create new supplier with ALL required fields
    console.log(`Creating new supplier: ${trimmedName}`);
    const [result] = await conn.execute(
      `INSERT INTO parties 
      (partyName, mobile, email, partyType, category, gstin, pan, billingAddress, shippingAddress, createdAt, updatedAt) 
      VALUES (?, ?, ?, 'Supplier', 'Wholesale', ?, ?, ?, ?, NOW(), NOW())`,
      [
        trimmedName,
        mobile || '0000000000',
        email || `${trimmedName.replace(/\s+/g, '').toLowerCase()}@supplier.com`,
        gstin || null, 
        pan || null, 
        billingAddress || '', 
        shippingAddress || ''
      ]
    );

    console.log(`Created new supplier with ID: ${result.insertId}`);
    return result.insertId;

  } catch (error) {
    console.error('Error in findOrCreateSupplierWithAddress:', error);
    
    if (error.code === 'ER_DUP_ENTRY') {
      console.error('Duplicate entry error - supplier might already exist');
      try {
        const [suppliers] = await conn.execute(
          'SELECT id FROM parties WHERE LOWER(partyName) = LOWER(?) AND partyType = "Supplier" LIMIT 1',
          [supplierName.trim()]
        );
        if (suppliers.length > 0) {
          return suppliers[0].id;
        }
      } catch (retryError) {
        console.error('Error retrying supplier search:', retryError);
      }
    }
    
    return null;
  }
}

// Import purchase orders from Excel
exports.importPurchaseOrders = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    // Check for Excel file
    if (!req.files || !req.files.file) {
      return res.status(400).json({ 
        success: false,
        message: 'No Excel file uploaded' 
      });
    }

    const excelFile = req.files.file[0];
    
    // Extract individual PDF files
    const individualPDFs = {};
    Object.entries(req.files).forEach(([fieldName, fileArray]) => {
      if (fieldName.startsWith('pdf_') && fileArray && fileArray[0]) {
        const rowIndex = fieldName.replace('pdf_', '');
        individualPDFs[rowIndex] = fileArray[0];
      }
    });

    console.log('Excel file:', excelFile.filename);
    console.log('Individual PDF files:', Object.keys(individualPDFs).length);

    // Read Excel file
    const workbook = XLSX.readFile(excelFile.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    
    if (jsonData.length <= 1) {
      // Clean up files
      fs.unlinkSync(excelFile.path);
      Object.values(individualPDFs).forEach(pdfFile => {
        fs.unlinkSync(pdfFile.path);
      });
      
      return res.status(400).json({
        success: false,
        message: 'Excel file is empty or has no data rows'
      });
    }

    const headers = jsonData[0].map(header => header ? header.toString().trim() : '');
    const dataRows = jsonData.slice(1);

    console.log('Headers found:', headers);
    console.log('Number of data rows:', dataRows.length);

    const results = {
      successful: [],
      failed: []
    };

    // Process each row
    for (const [index, row] of dataRows.entries()) {
      let rowData = {};
      let rowPDF = individualPDFs[index.toString()];
      
      try {
        // Skip empty rows
        if (row.length === 0 || !row.some(cell => cell !== null && cell !== undefined && cell !== '')) {
          console.log(`Skipping empty row ${index + 2}`);
          continue;
        }

        // Create row object from headers and data
        headers.forEach((header, colIndex) => {
          if (header && row[colIndex] !== undefined && row[colIndex] !== null) {
            rowData[header] = row[colIndex];
          }
        });

        console.log(`Processing row ${index + 2}:`, rowData);

        // Check if custom PO number is provided
        let orderNumber = null;
        if (rowData['PO Number'] && rowData['PO Number'].toString().trim() !== '') {
          orderNumber = rowData['PO Number'].toString().trim();
          console.log(`Using custom PO number: ${orderNumber}`);
        } else {
          // Auto-generate PO number
          const prefix = getPrefixByType('purchase_order');
          
          // Get next sequence for this project (if any)
          const projectId = rowData['Project ID'] ? parseInt(rowData['Project ID']) : null;
          
          const [existing] = await conn.execute(
            'SELECT * FROM invoice_sequences WHERE project_id <=> ? AND prefix = ? AND invoice_type = "purchase_order" FOR UPDATE',
            [projectId, prefix]
          );
          
          let invoiceSequence;
          if (existing.length === 0) {
            invoiceSequence = 1;
            await conn.execute(
              'INSERT INTO invoice_sequences (project_id, prefix, invoice_type, last_sequence) VALUES (?, ?, "purchase_order", ?)',
              [projectId, prefix, 1]
            );
          } else {
            invoiceSequence = existing[0].last_sequence + 1;
            await conn.execute(
              'UPDATE invoice_sequences SET last_sequence = ? WHERE project_id <=> ? AND prefix = ? AND invoice_type = "purchase_order"',
              [invoiceSequence, projectId, prefix]
            );
          }
          
          orderNumber = `${prefix}${invoiceSequence.toString().padStart(4, '0')}`;
          console.log(`Generated PO number: ${orderNumber}`);
        }

        // Validate required fields
        const requiredFields = [
          'Vendor Name*', 'GSTIN / PAN*', 'Billing Address*', 'Shipping Address*',
          'Contact Mobile*', 'Contact Email*'
        ];
        
        const missingFields = requiredFields.filter(field => {
          const value = rowData[field];
          return value === undefined || value === null || value === '' || 
                 (typeof value === 'string' && value.trim() === '');
        });
        
        if (missingFields.length > 0) {
          const errorMsg = `Missing required fields: ${missingFields.join(', ')}`;
          console.error(`Row ${index + 2}: ${errorMsg}`);
          results.failed.push({
            row: index + 2,
            data: rowData,
            error: errorMsg
          });
          continue;
        }

        // Parse multiple items from the row
        const items = parseMultipleItems(rowData);
        if (items.length === 0) {
          results.failed.push({
            row: index + 2,
            data: rowData,
            error: 'No valid items found. Please provide at least one item with description, quantity, and rate.'
          });
          continue;
        }

        console.log(`Found ${items.length} items in row ${index + 2}:`, items);

        // Validate mobile number
        const mobile = rowData['Contact Mobile*'].toString().trim();
        if (!mobile.match(/^[0-9]{10}$/)) {
          results.failed.push({
            row: index + 2,
            data: rowData,
            error: 'Invalid mobile number. Must be 10 digits.'
          });
          continue;
        }

        // Validate email
        const email = rowData['Contact Email*'].toString().trim();
        if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
          results.failed.push({
            row: index + 2,
            data: rowData,
            error: 'Invalid email format.'
          });
          continue;
        }

        // Extract GSTIN and PAN
        let gstin = null;
        let pan = null;
        const gstinPan = rowData['GSTIN / PAN*'].toString().trim();
        
        if (gstinPan.length === 15) {
          gstin = gstinPan;
        } else if (gstinPan.length === 10) {
          pan = gstinPan;
        } else {
          results.failed.push({
            row: index + 2,
            data: rowData,
            error: 'Invalid GSTIN/PAN. GSTIN must be 15 characters, PAN must be 10 characters.'
          });
          continue;
        }

        // Extract pincode from shipping address for tax calculation
        const shippingAddress = rowData['Shipping Address*'].toString();
        const pincode = extractPincode(shippingAddress);
        const isTN = isTamilNaduPincode(pincode);
        const taxType = isTN ? 'sgst_cgst' : 'igst';

        console.log(`Tax calculation - Pincode: ${pincode}, Is Tamil Nadu: ${isTN}, Tax Type: ${taxType}`);

        // Calculate totals from all items
        let totalGrossAmount = 0;
        let totalGstAmount = 0;
        let totalAmount = 0;

        items.forEach(item => {
          const itemGrossAmount = item.quantity * item.rate;
          const itemGstAmount = item.gstAmount || (itemGrossAmount * (item.gstPercent || 0) / 100);
          const itemTotalAmount = itemGrossAmount + itemGstAmount;

          totalGrossAmount += itemGrossAmount;
          totalGstAmount += itemGstAmount;
          totalAmount += itemTotalAmount;
        });

        // Find or create supplier
        const supplierId = await findOrCreateSupplierWithAddress(
          rowData['Vendor Name*'],
          gstin,
          pan,
          rowData['Billing Address*'],
          rowData['Shipping Address*'],
          mobile,
          email,
          conn
        );
        
        if (!supplierId) {
          const errorMsg = 'Failed to create or find supplier. Please check supplier details.';
          console.error(`Row ${index + 2}: ${errorMsg}`);
          results.failed.push({
            row: index + 2,
            data: rowData,
            error: errorMsg
          });
          continue;
        }

        console.log(`Supplier created/found with ID: ${supplierId}`);

        // Prepare PDF meta data
        let pdfMeta = null;
        if (rowPDF) {
          const uploadDir = 'uploads/purchase-orders';
          if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
          }

          const fileExtension = path.extname(rowPDF.originalname);
          const uniqueFileName = `po_pdf_${Date.now()}_${Math.random().toString(36).substring(7)}${fileExtension}`;
          const filePath = path.join(uploadDir, uniqueFileName);

          fs.renameSync(rowPDF.path, filePath);

          pdfMeta = {
            fileName: uniqueFileName,
            originalName: rowPDF.originalname,
            uploadedAt: new Date().toISOString(),
            filePath: filePath,
            associatedWithImport: true,
            rowIndex: index,
            fileSize: rowPDF.size,
            mimeType: rowPDF.mimetype
          };
          console.log(`PDF associated with row ${index + 2}: ${uniqueFileName}`);
        }

        // Parse order number for database
        const parsed = parseInvoiceNumberWithType(orderNumber, 'purchase_order');
        const isManualInvoice = rowData['PO Number'] ? true : false;

        // Create purchase order meta
        const purchaseOrderMeta = {
          orderStatus: (rowData['Payment Status'] || 'Unpaid') === 'Paid' ? 'confirmed' : 'draft',
          priority: 'medium',
          category: rowData['Category'] || 'General',
          paymentMode: rowData['Payment Mode'] || 'Cash',
          paymentStatus: rowData['Payment Status'] || 'Unpaid',
          importedFromExcel: true,
          taxType: taxType,
          billingAddress: rowData['Billing Address*'],
          shippingAddress: rowData['Shipping Address*'],
          pincode: pincode,
          taxableAmount: totalGrossAmount,
          contactMobile: mobile,
          contactEmail: email,
          isManualInvoice: isManualInvoice,
          invoicePrefix: parsed.prefix,
          generatedInvoiceNumber: orderNumber,
          ...(pdfMeta && { pdfFile: pdfMeta })
        };

        // Create purchase order
        const purchaseOrder = {
          invoiceNumber: orderNumber,
          date: new Date().toISOString().split('T')[0],
          dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          clientId: supplierId,
          status: 'draft',
          subTotal: totalGrossAmount,
          tax: totalGstAmount,
          discount: 0,
          total: totalAmount,
          notes: rowData['Remarks'] ? [rowData['Remarks']] : [],
          type: 'purchase_order',
          meta: purchaseOrderMeta
        };

        console.log(`Creating purchase order: ${orderNumber} with ${items.length} items`);

        // Insert purchase order with invoice number fields
        const [orderResult] = await conn.execute(
          `INSERT INTO invoices 
          (invoice_prefix, invoice_sequence, invoice_number_generated, is_manual_invoice, original_sequence, 
           invoiceNumber, date, dueDate, clientId, status, subTotal, tax, discount, total, notes, type, meta, createdAt, updatedAt) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            parsed.prefix,
            parsed.sequence || 0,
            orderNumber,
            isManualInvoice,
            parsed.sequence || null,
            parsed.sequenceStr || orderNumber,
            purchaseOrder.date,
            purchaseOrder.dueDate,
            purchaseOrder.clientId,
            purchaseOrder.status,
            purchaseOrder.subTotal,
            purchaseOrder.tax,
            purchaseOrder.discount,
            purchaseOrder.total,
            JSON.stringify(purchaseOrder.notes),
            'purchase_order',
            JSON.stringify(purchaseOrder.meta)
          ]
        );

        const orderId = orderResult.insertId;
        console.log(`Purchase order created with ID: ${orderId}`);

        // Insert all items
        for (const item of items) {
          const itemGrossAmount = item.quantity * item.rate;
          const itemGstAmount = item.gstAmount || (itemGrossAmount * (item.gstPercent || 0) / 100);
          const itemTotalAmount = itemGrossAmount + itemGstAmount;

          // Calculate tax breakdown for this item
          const sgst = taxType === 'sgst_cgst' ? (item.gstPercent || 0) / 2 : 0;
          const cgst = taxType === 'sgst_cgst' ? (item.gstPercent || 0) / 2 : 0;
          const igst = taxType === 'igst' ? (item.gstPercent || 0) : 0;

          const sgstAmount = taxType === 'sgst_cgst' ? itemGstAmount / 2 : 0;
          const cgstAmount = taxType === 'sgst_cgst' ? itemGstAmount / 2 : 0;
          const igstAmount = taxType === 'igst' ? itemGstAmount : 0;

          await conn.execute(
            `INSERT INTO invoice_items 
            (invoiceId, description, hsn, uom, quantity, rate, amount, tax, taxAmount, meta, createdAt, updatedAt) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
              orderId,
              item.description,
              item.hsn || '',
              item.uom || 'PCS',
              item.quantity,
              item.rate,
              itemGrossAmount,
              item.gstPercent || 0,
              itemGstAmount,
              JSON.stringify({
                taxType: taxType,
                sgst: sgst,
                cgst: cgst,
                igst: igst,
                sgstAmount: sgstAmount,
                cgstAmount: cgstAmount,
                igstAmount: igstAmount,
                taxableAmount: itemGrossAmount,
                hsnCode: item.hsn || '',
                uom: item.uom || 'PCS'
              })
            ]
          );
        }

        console.log(`All ${items.length} items created for order ID: ${orderId}`);

        // Commit transaction FIRST for this order
        await conn.commit();

        // THEN log the import action
        logPurchaseOrderAction(
          orderId,
          'imported',
          `Purchase order ${orderNumber} imported from Excel with ${items.length} items`,
          {
            orderNumber: orderNumber,
            supplier: supplierId,
            total: totalAmount,
            items: items.length,
            taxType: taxType,
            importedFromExcel: true
          },
          req
        );

        results.successful.push({
          row: index + 2,
          orderNumber: purchaseOrder.invoiceNumber,
          orderId: orderId,
          supplier: rowData['Vendor Name*'],
          amount: totalAmount,
          items: items.length,
          hasPDF: !!pdfMeta,
          pdfFileName: pdfMeta ? pdfMeta.fileName : null
        });

        console.log(`Row ${index + 2} processed successfully with ${items.length} items`);

      } catch (error) {
        await conn.rollback();
        console.error(`Error processing row ${index + 2}:`, error);
        results.failed.push({
          row: index + 2,
          data: rowData,
          error: error.message || 'Unknown error occurred during processing'
        });
        
        // Start new transaction for next row
        await conn.beginTransaction();
      }
    }

    console.log(`Import completed: ${results.successful.length} successful, ${results.failed.length} failed`);

    // Clean up uploaded files
    fs.unlinkSync(excelFile.path);
    
    // Only delete PDF files if their associated rows failed
    Object.entries(individualPDFs).forEach(([rowIndex, pdfFile]) => {
      const rowSuccess = results.successful.some(result => 
        result.row === parseInt(rowIndex) + 2
      );
      if (!rowSuccess && fs.existsSync(pdfFile.path)) {
        fs.unlinkSync(pdfFile.path);
        console.log(`PDF file deleted for failed row ${rowIndex}: ${pdfFile.filename}`);
      } else if (rowSuccess) {
        console.log(`PDF file retained for successful row ${rowIndex}: ${pdfFile.filename}`);
      }
    });

    const pdfSuccessCount = results.successful.filter(result => result.hasPDF).length;
    
    res.json({
      success: true,
      message: `Import completed: ${results.successful.length} successful, ${results.failed.length} failed`,
      results: results,
      totalImported: results.successful.length,
      pdfAssociated: pdfSuccessCount,
      individualPDFs: pdfSuccessCount > 0
    });

  } catch (error) {
    await conn.rollback();
    console.error('Import transaction error:', error);
    
    // Clean up all uploaded files in case of error
    if (req.files?.file?.[0] && fs.existsSync(req.files.file[0].path)) {
      fs.unlinkSync(req.files.file[0].path);
    }
    
    // Clean up all individual PDF files
    Object.entries(req.files).forEach(([fieldName, fileArray]) => {
      if (fieldName.startsWith('pdf_') && fileArray && fileArray[0] && fs.existsSync(fileArray[0].path)) {
        fs.unlinkSync(fileArray[0].path);
      }
    });

    res.status(500).json({
      success: false,
      message: 'Failed to import purchase orders',
      error: error.message
    });
  } finally {
    conn.release();
  }
};

// Helper function to parse multiple items from a single row
function parseMultipleItems(rowData) {
  const items = [];
  
  const itemPatterns = [
    { prefix: 'Item 1', required: true },
    { prefix: 'Item 2', required: false },
    { prefix: 'Item 3', required: false },
    { prefix: 'Item 4', required: false },
    { prefix: 'Item 5', required: false }
  ];

  for (const pattern of itemPatterns) {
    const description = rowData[`${pattern.prefix} - Description`];
    const quantity = rowData[`${pattern.prefix} - Quantity`];
    const rate = rowData[`${pattern.prefix} - Rate`];
    
    if (pattern.required && (!description || !quantity || !rate)) {
      if (items.length === 0) {
        return [];
      }
      break;
    }
    
    if (!pattern.required && (!description || !quantity || !rate)) {
      break;
    }

    const parsedQuantity = parseFloat(quantity);
    const parsedRate = parseFloat(rate);
    
    if (isNaN(parsedQuantity) || parsedQuantity <= 0) {
      if (pattern.required) {
        return [];
      }
      continue;
    }
    
    if (isNaN(parsedRate) || parsedRate < 0) {
      if (pattern.required) {
        return [];
      }
      continue;
    }

    const item = {
      description: description.toString().trim(),
      quantity: parsedQuantity,
      rate: parsedRate,
      hsn: rowData[`${pattern.prefix} - HSN`] ? rowData[`${pattern.prefix} - HSN`].toString().trim() : '',
      uom: rowData[`${pattern.prefix} - UOM`] ? rowData[`${pattern.prefix} - UOM`].toString().trim() : 'PCS',
      gstPercent: rowData[`${pattern.prefix} - GST %`] ? parseFloat(rowData[`${pattern.prefix} - GST %`]) : 0,
      gstAmount: rowData[`${pattern.prefix} - GST Amount`] ? parseFloat(rowData[`${pattern.prefix} - GST Amount`]) : 0
    };

    items.push(item);
  }

  return items;
}

// Upload PO PDF
exports.uploadPOPDF = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No PDF file uploaded'
      });
    }

    const { orderId } = req.body;
    const fileName = req.file.filename;
    const originalName = req.file.originalname;

    if (orderId) {
      // Associate PDF with existing purchase order
      const [rows] = await db.execute(
        'SELECT meta FROM invoices WHERE id = ? AND type = "purchase_order"',
        [orderId]
      );

      if (rows.length === 0) {
        fs.unlinkSync(req.file.path);
        return res.status(404).json({
          success: false,
          message: 'Purchase order not found'
        });
      }

      let meta = {};
      if (rows[0].meta) {
        meta = typeof rows[0].meta === 'string' ? JSON.parse(rows[0].meta) : rows[0].meta;
      }

      meta.pdfFile = {
        fileName: fileName,
        originalName: originalName,
        uploadedAt: new Date().toISOString()
      };

      await db.execute(
        'UPDATE invoices SET meta = ? WHERE id = ?',
        [JSON.stringify(meta), orderId]
      );

      // Log PDF upload action
      logPurchaseOrderAction(
        orderId,
        'pdf_uploaded',
        `PDF document uploaded for purchase order`,
        {
          fileName: fileName,
          originalName: originalName
        },
        req
      );
    }

    res.json({
      success: true,
      message: 'PDF uploaded successfully',
      fileName,
      originalName,
      orderId
    });

  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    console.error('PDF upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload PDF',
      error: error.message
    });
  }
};

// Get PO PDF
exports.getPOPDF = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.execute(
      'SELECT meta FROM invoices WHERE id = ? AND type = "purchase_order"',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Purchase order not found'
      });
    }

    const meta = typeof rows[0].meta === 'string' ? JSON.parse(rows[0].meta) : rows[0].meta;
    const pdfFile = meta?.pdfFile;

    if (!pdfFile || !pdfFile.fileName) {
      return res.status(404).json({
        success: false,
        message: 'PDF not found for this purchase order'
      });
    }

    const fullPath = path.join('uploads/purchase-orders/', pdfFile.fileName);
    
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({
        success: false,
        message: 'PDF file not found on server'
      });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${pdfFile.originalName || 'purchase-order.pdf'}"`);
    
    const fileStream = fs.createReadStream(fullPath);
    fileStream.pipe(res);

  } catch (error) {
    console.error('PDF retrieval error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve PDF',
      error: error.message
    });
  }
};

// Download Excel Template with multi-item support
exports.downloadTemplate = (req, res) => {
  try {
    const templateData = [
      {
        'PO Number': 'ICE/25-26/PO/001',
        'Category': 'Office Supplies',
        'Vendor Name*': 'ABC Suppliers Pvt Ltd',
        'GSTIN / PAN*': '29ABCDE1234F1Z5',
        'Billing Address*': '123 Business Street, GST Nagar, Chennai - 600001, Tamil Nadu',
        'Shipping Address*': '123 Business Street, GST Nagar, Chennai - 600001, Tamil Nadu',
        'Contact Mobile*': '9876543210',
        'Contact Email*': 'abc.suppliers@example.com',
        
        // Item 1 (Required)
        'Item 1 - Description': 'Laptop Dell XPS 15',
        'Item 1 - HSN': '84713000',
        'Item 1 - UOM': 'PCS',
        'Item 1 - Quantity': '2',
        'Item 1 - Rate': '50000',
        'Item 1 - GST %': '18',
        'Item 1 - GST Amount': '18000',
        
        // Item 2 (Optional)
        'Item 2 - Description': 'Wireless Mouse',
        'Item 2 - HSN': '84716070',
        'Item 2 - UOM': 'PCS',
        'Item 2 - Quantity': '5',
        'Item 2 - Rate': '800',
        'Item 2 - GST %': '18',
        'Item 2 - GST Amount': '720',
        
        // Item 3 (Optional)
        'Item 3 - Description': 'Laptop Bag',
        'Item 3 - HSN': '42021290',
        'Item 3 - UOM': 'PCS',
        'Item 3 - Quantity': '2',
        'Item 3 - Rate': '1200',
        'Item 3 - GST %': '12',
        'Item 3 - GST Amount': '288',
        
        // Totals
        'Gross Amount*': '101600',
        'Total GST Amount': '19008',
        'Total Amount*': '120608',
        
        'Payment Mode': 'Bank Transfer',
        'Payment Status': 'Unpaid',
        'Remarks': 'Urgent delivery required for laptops'
      }
    ];

    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(templateData);
    
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Purchase Orders Template');

    const colWidths = [
      { wch: 18 },  // PO Number
      { wch: 15 },  // Category
      { wch: 25 },  // Vendor Name*
      { wch: 18 },  // GSTIN / PAN*
      { wch: 30 },  // Billing Address*
      { wch: 30 },  // Shipping Address*
      { wch: 15 },  // Contact Mobile*
      { wch: 20 },  // Contact Email*
      
      // Item 1 columns
      { wch: 25 },  // Item 1 - Description
      { wch: 12 },  // Item 1 - HSN
      { wch: 8 },   // Item 1 - UOM
      { wch: 10 },  // Item 1 - Quantity
      { wch: 12 },  // Item 1 - Rate
      { wch: 8 },   // Item 1 - GST %
      { wch: 12 },  // Item 1 - GST Amount
      
      // Item 2 columns
      { wch: 25 },  // Item 2 - Description
      { wch: 12 },  // Item 2 - HSN
      { wch: 8 },   // Item 2 - UOM
      { wch: 10 },  // Item 2 - Quantity
      { wch: 12 },  // Item 2 - Rate
      { wch: 8 },   // Item 2 - GST %
      { wch: 12 },  // Item 2 - GST Amount
      
      // Item 3 columns
      { wch: 25 },  // Item 3 - Description
      { wch: 12 },  // Item 3 - HSN
      { wch: 8 },   // Item 3 - UOM
      { wch: 10 },  // Item 3 - Quantity
      { wch: 12 },  // Item 3 - Rate
      { wch: 8 },   // Item 3 - GST %
      { wch: 12 },  // Item 3 - GST Amount
      
      // Totals
      { wch: 15 },  // Gross Amount*
      { wch: 15 },  // Total GST Amount
      { wch: 15 },  // Total Amount*
      
      { wch: 15 },  // Payment Mode
      { wch: 15 },  // Payment Status
      { wch: 25 }   // Remarks
    ];
    worksheet['!cols'] = colWidths;

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=purchase-order-multi-item-template.xlsx');
    res.send(buffer);

  } catch (error) {
    console.error('Template download error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate template',
      error: error.message
    });
  }
};

// Associate PDF with purchase order
exports.associatePDFWithOrder = async (req, res) => {
  try {
    const { orderId, fileName, originalName } = req.body;

    if (!orderId || !fileName) {
      return res.status(400).json({
        success: false,
        message: 'Order ID and file name are required'
      });
    }

    const [rows] = await db.execute(
      'SELECT meta FROM invoices WHERE id = ? AND type = "purchase_order"',
      [orderId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Purchase order not found'
      });
    }

    let meta = {};
    if (rows[0].meta) {
      meta = typeof rows[0].meta === 'string' ? JSON.parse(rows[0].meta) : rows[0].meta;
    }

    meta.pdfFile = {
      fileName: fileName,
      originalName: originalName || 'purchase-order.pdf',
      uploadedAt: new Date().toISOString(),
      filePath: `uploads/purchase-orders/${fileName}`
    };

    await db.execute(
      'UPDATE invoices SET meta = ? WHERE id = ?',
      [JSON.stringify(meta), orderId]
    );

    // Log PDF association action
    logPurchaseOrderAction(
      orderId,
      'pdf_associated',
      `PDF document associated with purchase order`,
      {
        fileName: fileName,
        originalName: originalName
      },
      req
    );

    res.json({
      success: true,
      message: 'PDF associated with purchase order successfully',
      orderId
    });

  } catch (error) {
    console.error('PDF association error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to associate PDF with order',
      error: error.message
    });
  }
};

// Get purchase order history logs
exports.getHistory = async (req, res) => {
  try {
    const [logs] = await db.execute(
      `SELECT * FROM invoice_history 
       WHERE invoiceId = ? 
       ORDER BY createdAt DESC`,
      [req.params.id]
    );

    const parsedLogs = logs.map(log => ({
      ...log,
      changes: log.changes ? (typeof log.changes === 'string' ? JSON.parse(log.changes) : log.changes) : {}
    }));

    res.json(parsedLogs);
  } catch (err) {
    console.error("Error fetching purchase order history:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// List all PURCHASE ORDERS with supplier + items
exports.list = async (req, res) => {
  try {
    const [orders] = await db.execute(`
      SELECT i.*, p.partyName as supplierName
      FROM invoices i
      LEFT JOIN parties p ON i.clientId = p.id
      WHERE i.type = 'purchase_order'
      ORDER BY i.createdAt DESC
    `);

    for (const order of orders) {
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
      `, [order.id]);
      
      if (order.meta && typeof order.meta === 'string') {
        try {
          order.meta = JSON.parse(order.meta);
        } catch (e) {
          console.error("Error parsing order meta:", e);
          order.meta = {};
        }
      } else if (!order.meta) {
        order.meta = {};
      }

      order.items = items.map(item => {
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
            item.taxType = item.meta.taxType || 'sgst_cgst';
          }
        } else {
          item.meta = {};
        }
        
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
    }

    res.json(orders);
  } catch (err) {
    console.error("Error fetching purchase orders:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get purchase orders by project
exports.getPurchaseOrdersByProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    
    const [orders] = await db.execute(`
      SELECT i.*, p.partyName as supplierName
      FROM invoices i
      LEFT JOIN parties p ON i.clientId = p.id
      WHERE i.type = 'purchase_order' AND i.project_id = ?
      ORDER BY i.createdAt DESC
    `, [projectId]);

    for (const order of orders) {
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
      `, [order.id]);
      
      if (order.meta && typeof order.meta === 'string') {
        try {
          order.meta = JSON.parse(order.meta);
        } catch (e) {
          console.error("Error parsing order meta:", e);
          order.meta = {};
        }
      } else if (!order.meta) {
        order.meta = {};
      }

      order.items = items.map(item => {
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
            item.taxType = item.meta.taxType || 'sgst_cgst';
          }
        } else {
          item.meta = {};
        }
        
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
    }

    res.json({ purchaseOrders: orders });
  } catch (err) {
    console.error("Error fetching project purchase orders:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get single PURCHASE ORDER by ID
exports.get = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT i.*, p.project_name as projectName FROM invoices i LEFT JOIN projects p ON i.project_id = p.id WHERE i.id = ? AND i.type = 'purchase_order'",
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Purchase order not found" });

    const order = rows[0];

    // Handle meta data
    if (order.meta) {
      if (typeof order.meta === 'string') {
        try {
          order.meta = JSON.parse(order.meta);
        } catch (e) {
          console.error("Error parsing order meta:", e);
          order.meta = {};
        }
      }
    } else {
      order.meta = {};
    }

    const [supplier] = await db.execute(
      "SELECT * FROM parties WHERE id = ?",
      [order.clientId]
    );
    order.supplier = supplier[0] || null;

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
    `, [order.id]);
    
    order.items = items.map(item => {
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
          item.taxType = item.meta.taxType || 'sgst_cgst';
        }
      } else {
        item.meta = {};
      }
      
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

    if (order.meta.projectId) {
      order.projectId = order.meta.projectId;
      order.projectName = order.meta.projectName || order.projectName;
    }

    res.json(order);
  } catch (err) {
    console.error("Error fetching purchase order:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Create PURCHASE ORDER with items and logging
exports.create = async (req, res) => {
  const payload = req.body;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    console.log("Creating purchase order for project:", payload.projectId);
    console.log("Manual order number:", payload.manualInvoiceNumber);

    const taxType = payload.taxType || 'sgst_cgst';
    console.log("Using tax type:", taxType);

    // ==================== INVOICE NUMBER HANDLING ====================
    let invoiceSequence;
    let generatedNumber;
    let isManualInvoice = false;
    let originalSequence = null;
    let sequenceStr = null;
    const invoicePrefix = getPrefixByType('purchase_order');

    if (payload.manualInvoiceNumber) {
      // User provided manual order number
      console.log("Using manual order number:", payload.manualInvoiceNumber);
      
      const parsed = parseInvoiceNumberWithType(payload.manualInvoiceNumber, 'purchase_order');
      
      if (!parsed.number) {
        await conn.rollback();
        return res.status(400).json({ 
          message: "Invalid order number format" 
        });
      }
      
      generatedNumber = parsed.number;
      
      // Validate uniqueness
      const isValid = await validateInvoiceNumber(
        conn,
        generatedNumber,
        payload.projectId !== undefined ? payload.projectId : null,
        null,
        'purchase_order'
      );
      
      if (!isValid) {
        await conn.rollback();
        return res.status(400).json({
          message: `Order number "${generatedNumber}" already exists ${payload.projectId ? 'for this project' : 'globally'}`,
          available: false,
          existingInvoice: true
        });
      }
      
      invoiceSequence = parsed.sequence || 0;
      isManualInvoice = true;
      originalSequence = parsed.sequence || null;
      sequenceStr = parsed.sequenceStr;
      
      // Update sequence tracker if needed
      if (parsed.sequence && !isNaN(parsed.sequence)) {
        const [existing] = await conn.execute(
          'SELECT * FROM invoice_sequences WHERE project_id <=> ? AND prefix = ? AND invoice_type = "purchase_order" FOR UPDATE',
          [payload.projectId !== undefined ? payload.projectId : null, invoicePrefix]
        );
        
        if (existing.length === 0) {
          await conn.execute(
            'INSERT INTO invoice_sequences (project_id, prefix, invoice_type, last_sequence) VALUES (?, ?, "purchase_order", ?)',
            [payload.projectId !== undefined ? payload.projectId : null, invoicePrefix, parsed.sequence]
          );
        } else if (parsed.sequence > existing[0].last_sequence) {
          await conn.execute(
            'UPDATE invoice_sequences SET last_sequence = ? WHERE project_id <=> ? AND prefix = ? AND invoice_type = "purchase_order"',
            [parsed.sequence, payload.projectId !== undefined ? payload.projectId : null, invoicePrefix]
          );
        }
      }
    } else {
      // Auto-generate order number
      console.log("Auto-generating order number for project:", payload.projectId);
      
      // Get next sequence number
      const [existing] = await conn.execute(
        'SELECT * FROM invoice_sequences WHERE project_id <=> ? AND prefix = ? AND invoice_type = "purchase_order" FOR UPDATE',
        [payload.projectId !== undefined ? payload.projectId : null, invoicePrefix]
      );
      
      if (existing.length === 0) {
        invoiceSequence = 1;
        await conn.execute(
          'INSERT INTO invoice_sequences (project_id, prefix, invoice_type, last_sequence) VALUES (?, ?, "purchase_order", ?)',
          [payload.projectId !== undefined ? payload.projectId : null, invoicePrefix, 1]
        );
      } else {
        invoiceSequence = existing[0].last_sequence + 1;
        await conn.execute(
          'UPDATE invoice_sequences SET last_sequence = ? WHERE project_id <=> ? AND prefix = ? AND invoice_type = "purchase_order"',
          [invoiceSequence, payload.projectId !== undefined ? payload.projectId : null, invoicePrefix]
        );
      }
      
      // Generate the full order number with padding
      generatedNumber = payload.projectId == undefined || payload.projectId == null ? 
        payload.invoiceNumber : `${invoicePrefix}${invoiceSequence.toString().padStart(4, '0')}`;
      
      // Double-check uniqueness
      const isValid = await validateInvoiceNumber(
        conn,
        generatedNumber,
        payload.projectId !== undefined ? payload.projectId : null,
        null,
        'purchase_order'
      );
      
      if (!isValid) {
        await conn.rollback();
        return res.status(400).json({
          message: `Generated order number "${generatedNumber}" already exists. Please try again.`,
          available: false
        });
      }
      
      sequenceStr = invoiceSequence.toString().padStart(4, '0');
      console.log("Generated order number:", generatedNumber);
    }

    // Calculate subtotal
    const subtotal = payload.items.reduce((sum, item) => {
      return sum + calculateItemBaseAmount(item);
    }, 0);
    
    const discountValue = payload.discount && payload.discount.type === "percent" && payload.discount.value
      ? (subtotal * parseFloat(payload.discount.value)) / 100 
      : (parseFloat(payload.discount?.value) || 0);
    
    const additionalChargesTotal = payload.additionalCharges?.reduce((sum, charge) => sum + (parseFloat(charge.amount) || 0), 0) || 0;
    
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
    
    console.log("Final total:", finalTotal, "Rounding applied:", payload.roundingApplied);

    // Create meta object for purchase order specific fields with tax type
    const meta = {
      taxType: taxType,
      orderNumber: generatedNumber,
      orderDate: payload.orderDate || payload.date,
      expectedDeliveryDate: payload.expectedDeliveryDate || "",
      discount: payload.discount || { type: "flat", value: 0 },
      discountValue: discountValue,
      additionalCharges: payload.additionalCharges || [],
      additionalChargesTotal: additionalChargesTotal,
      applyTCS: payload.applyTCS || false,
      tcs: tcs,
      taxableAmount: taxable,
      sgstTotal: sgstTotal,
      cgstTotal: cgstTotal,
      igstTotal: igstTotal,
      totalTax: totalTax,
      
      // Rounding information
      roundingApplied: payload.roundingApplied || false,
      originalTotal: payload.originalTotal || calculatedTotal,
      roundedTotal: payload.roundedTotal || finalTotal,
      roundingDifference: payload.roundingDifference || (payload.roundingApplied ? (finalTotal - calculatedTotal) : 0),
      
      // Payment information
      amountReceived: payload.amountReceived || 0,
      paymentMode: payload.paymentMode || "Cash",
      paymentTerms: payload.paymentTerms || "",
      
      // Bank details
      bankDetails: payload.bankDetails || null,
      
      // Address information
      billingAddress: payload.billingAddress || "",
      shippingAddress: payload.shippingAddress || "",
      deliveryAddress: payload.deliveryAddress || "",
      
      // Other fields
      poNumber: payload.poNumber || "",
      ewayBillNumber: payload.ewayBillNumber || "",
      deliveryTerms: payload.deliveryTerms || "",
      shippingMethod: payload.shippingMethod || "",
      notes: payload.notes || [],
      
      // Order status
      orderStatus: payload.orderStatus || "draft",
      priority: payload.priority || "medium",

      // Project information
      projectId: payload.projectId || null,
      projectName: payload.projectName || null,

      // Invoice number information
      isManualInvoice: isManualInvoice,
      invoicePrefix: invoicePrefix,
      generatedInvoiceNumber: generatedNumber
    };

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
        sequenceStr,
        payload.date,
        payload.dueDate || payload.expectedDeliveryDate,
        payload.clientId,
        payload.status || "draft",
        subtotal,
        totalTax,
        payload.totalDiscountAmount || discountValue,
        payload.total ?? finalTotal,
        JSON.stringify(payload.notes || []),
        payload.signature || null,
        'purchase_order',
        JSON.stringify(meta),
        payload.projectId || null
      ]
    );

    const orderId = result.insertId;

    // Insert items with purchase price and GST based on tax type
    for (const item of payload.items) {
      const amounts = calculateItemAmounts(item, taxType);

      console.log(`Item: ${item.description}`, {
        quantity: item.quantity,
        rate: item.rate,
        discount: item.discount,
        tax: item.tax,
        sgst: item.sgst,
        cgst: item.cgst,
        igst: item.igst,
        taxType: taxType,
        baseAmount: amounts.baseAmount,
        totalAmount: amounts.totalAmount,
        sgstAmount: amounts.sgstAmount,
        cgstAmount: amounts.cgstAmount,
        igstAmount: amounts.igstAmount
      });

      // Create item meta with tax type information
      const itemMeta = {
        taxType: taxType,
        sgst: taxType === 'sgst_cgst' ? (item.sgst || 9) : 0,
        cgst: taxType === 'sgst_cgst' ? (item.cgst || 9) : 0,
        igst: taxType === 'igst' ? (item.igst || 18) : 0,
        sgstAmount: parseFloat(amounts.sgstAmount.toFixed(2)),
        cgstAmount: parseFloat(amounts.cgstAmount.toFixed(2)),
        igstAmount: parseFloat(amounts.igstAmount.toFixed(2)),
        taxableAmount: parseFloat(amounts.taxableAmount.toFixed(2))
      };

      await conn.execute(
        `INSERT INTO invoice_items 
        (invoiceId, itemId, description, hsn, uom, quantity, rate, discount, tax, taxAmount, amount, meta) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          item.itemId || null,
          item.description,
          item.hsn || '',
          item.uom || '',
          parseFloat(item.quantity),
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
    logPurchaseOrderAction(
      orderId,
      'created',
      `Purchase order ${generatedNumber} created with ${payload.items.length} items`,
      {
        orderNumber: generatedNumber,
        invoiceSequence: invoiceSequence,
        sequenceString: sequenceStr,
        isManualInvoice: isManualInvoice,
        supplier: payload.clientId,
        total: payload.total ?? finalTotal,
        items: payload.items.length,
        taxType: taxType,
        status: payload.status || "draft",
        projectId: payload.projectId || null
      },
      req
    );

    res.status(201).json({ 
      message: "Purchase order created", 
      id: orderId,
      orderNumber: generatedNumber,
      invoiceSequence: invoiceSequence,
      sequenceString: sequenceStr,
      isManualInvoice: isManualInvoice,
      taxType: taxType,
      total: payload.total ?? finalTotal,
      roundingApplied: payload.roundingApplied || false,
      projectId: payload.projectId || null
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error creating purchase order:", err);
    
    if (err.code === 'ER_DUP_ENTRY' || err.message.includes('Duplicate entry')) {
      res.status(400).json({ 
        message: "Order number already exists. Please use a different number."
      });
    } else {
      res.status(500).json({ 
        message: "Error creating purchase order", 
        error: err.message 
      });
    }
  } finally {
    conn.release();
  }
};

// Update PURCHASE ORDER with logging
exports.update = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'purchase_order'", 
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Purchase order not found" });
    }

    const oldOrder = rows[0];
    const payload = req.body;

    const changes = {};
    
    // Compare basic fields
    if (oldOrder.status !== payload.status) {
      changes.status = { from: oldOrder.status, to: payload.status };
    }
    if (parseFloat(oldOrder.total).toFixed(2) !== parseFloat(payload.total).toFixed(2)) {
      changes.total = { from: parseFloat(oldOrder.total), to: parseFloat(payload.total) };
    }
    if (oldOrder.clientId !== payload.clientId) {
      changes.supplier = { from: oldOrder.clientId, to: payload.clientId };
    }

    // Parse old meta
    let oldTaxType = 'sgst_cgst';
    let oldMeta = {};
    if (oldOrder.meta) {
      try {
        oldMeta = typeof oldOrder.meta === 'string' ? JSON.parse(oldOrder.meta) : oldOrder.meta;
        oldTaxType = oldMeta.taxType || 'sgst_cgst';
      } catch (e) {
        console.error("Error parsing old order meta:", e);
      }
    }

    // Format dates
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
    const formattedExpectedDeliveryDate = formatDateForMySQL(payload.expectedDeliveryDate);

    // Get tax type from payload
    const taxType = payload.taxType || 'sgst_cgst';

    if (oldTaxType !== taxType) {
      changes.taxType = { from: oldTaxType, to: taxType };
    }

    // ==================== INVOICE NUMBER HANDLING FOR UPDATE ====================
    let newGeneratedNumber = oldOrder.invoice_number_generated;
    let newInvoiceSequence = oldOrder.invoice_sequence;
    let isManualInvoice = oldOrder.is_manual_invoice;
    let originalSequence = oldOrder.original_sequence;
    let sequenceStr = oldOrder.invoiceNumber;
    let invoiceNumberChanged = false;
    const invoicePrefix = getPrefixByType('purchase_order');

    console.log("Current order number:", newGeneratedNumber);
    console.log("New order number from payload:", payload.manualInvoiceNumber);
    console.log("Invoice prefix:", invoicePrefix);

    // Check if order number is being changed in manual mode
    if (payload.manualInvoiceNumber && payload.manualInvoiceNumber !== newGeneratedNumber) {
      console.log("Order number changed from", newGeneratedNumber, "to", payload.manualInvoiceNumber);
      invoiceNumberChanged = true;
      
      const parsed = parseInvoiceNumberWithType(payload.manualInvoiceNumber, 'purchase_order');
      
      if (!parsed.number) {
        await conn.rollback();
        return res.status(400).json({ message: "Invalid order number format" });
      }
      
      newGeneratedNumber = parsed.number;
      
      // Validate uniqueness ONLY if number has changed
      const isValid = await validateInvoiceNumber(
        conn,
        newGeneratedNumber,
        payload.projectId !== undefined ? payload.projectId : null,
        req.params.id,
        'purchase_order'
      );
      
      if (!isValid) {
        await conn.rollback();
        return res.status(400).json({
          message: `Order number "${newGeneratedNumber}" already exists ${payload.projectId ? 'for this project' : 'globally'}`,
          available: false,
          existingInvoice: true
        });
      }
      
      newInvoiceSequence = parsed.sequence || 0;
      isManualInvoice = true;
      originalSequence = parsed.sequence || null;
      sequenceStr = parsed.sequenceStr;
      
      // Update sequence tracker if needed
      if (parsed.sequence && !isNaN(parsed.sequence)) {
        const [existing] = await conn.execute(
          'SELECT * FROM invoice_sequences WHERE project_id <=> ? AND prefix = ? AND invoice_type = "purchase_order" FOR UPDATE',
          [payload.projectId !== undefined ? payload.projectId : null, invoicePrefix]
        );
        
        if (existing.length === 0) {
          await conn.execute(
            'INSERT INTO invoice_sequences (project_id, prefix, invoice_type, last_sequence) VALUES (?, ?, "purchase_order", ?)',
            [payload.projectId !== undefined ? payload.projectId : null, invoicePrefix, parsed.sequence]
          );
        } else if (parsed.sequence > existing[0].last_sequence) {
          await conn.execute(
            'UPDATE invoice_sequences SET last_sequence = ? WHERE project_id <=> ? AND prefix = ? AND invoice_type = "purchase_order"',
            [parsed.sequence, payload.projectId !== undefined ? payload.projectId : null, invoicePrefix]
          );
        }
      }
      
      // Track invoice number change
      changes.invoiceNumber = { 
        from: oldOrder.invoice_number_generated, 
        to: newGeneratedNumber 
      };
      changes.isManualInvoice = { from: oldOrder.is_manual_invoice, to: true };
      changes.sequenceString = { from: oldOrder.invoiceNumber, to: sequenceStr };
    } 
    // Check if in auto mode and sequence is being changed
    else if (!payload.manualInvoiceNumber) {
      const oldSequence = oldOrder.invoiceNumber;
      const newSequence = payload.invoiceNumber ? payload.invoiceNumber.padStart(4, '0') : oldSequence;
      
      if (oldSequence !== newSequence) {
        invoiceNumberChanged = true;
        
        // Build full invoice number
        newGeneratedNumber = `${invoicePrefix}${newSequence}`;
        
        // Only validate if the generated number is different from current
        if (newGeneratedNumber !== oldOrder.invoice_number_generated) {
          const isValid = await validateInvoiceNumber(
            conn,
            newGeneratedNumber,
            payload.projectId !== undefined ? payload.projectId : null,
            req.params.id,
            'purchase_order'
          );
          
          if (!isValid) {
            await conn.rollback();
            return res.status(400).json({
              message: `Order number "${newGeneratedNumber}" already exists ${payload.projectId ? 'for this project' : 'globally'}`,
              available: false,
              existingInvoice: true
            });
          }
        }
        
        // Update sequence
        const sequenceNum = parseInt(newSequence, 10);
        if (!isNaN(sequenceNum)) {
          newInvoiceSequence = sequenceNum;
          sequenceStr = newSequence;
          
          // Update sequence tracker if sequence increased
          if (sequenceNum > oldOrder.invoice_sequence) {
            const [existing] = await conn.execute(
              'SELECT * FROM invoice_sequences WHERE project_id <=> ? AND prefix = ? AND invoice_type = "purchase_order" FOR UPDATE',
              [payload.projectId !== undefined ? payload.projectId : null, invoicePrefix]
            );
            
            if (existing.length === 0) {
              await conn.execute(
                'INSERT INTO invoice_sequences (project_id, prefix, invoice_type, last_sequence) VALUES (?, ?, "purchase_order", ?)',
                [payload.projectId !== undefined ? payload.projectId : null, invoicePrefix, sequenceNum]
              );
            } else if (sequenceNum > existing[0].last_sequence) {
              await conn.execute(
                'UPDATE invoice_sequences SET last_sequence = ? WHERE project_id <=> ? AND prefix = ? AND invoice_type = "purchase_order"',
                [sequenceNum, payload.projectId !== undefined ? payload.projectId : null, invoicePrefix]
              );
            }
          }
        }
        
        if (newGeneratedNumber !== oldOrder.invoice_number_generated) {
          changes.invoiceNumber = { 
            from: oldOrder.invoice_number_generated, 
            to: newGeneratedNumber 
          };
        }
        if (oldSequence !== newSequence) {
          changes.sequenceString = { from: oldSequence, to: newSequence };
        }
      }
    }
    // If manualInvoiceNumber is provided but same as current, keep existing values
    else if (payload.manualInvoiceNumber && payload.manualInvoiceNumber === newGeneratedNumber) {
      // Number hasn't changed, keep existing values
      console.log("Order number unchanged, keeping existing values");
      // No validation needed since number is the same
    }

    // Calculate subtotal
    const subtotal = payload.items.reduce((sum, item) => {
      return sum + calculateItemBaseAmount(item);
    }, 0);
    
    const discountValue = payload.discount && payload.discount.type === "percent" && payload.discount.value
      ? (subtotal * parseFloat(payload.discount.value)) / 100 
      : (parseFloat(payload.discount?.value) || 0);
    
    const additionalChargesTotal = payload.additionalCharges?.reduce((sum, charge) => sum + (parseFloat(charge.amount) || 0), 0) || 0;
    
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

    // Create meta object for purchase order with tax type
    const meta = {
      taxType: taxType,
      orderNumber: newGeneratedNumber,
      orderDate: payload.orderDate || payload.date,
      expectedDeliveryDate: payload.expectedDeliveryDate || "",
      discount: payload.discount || { type: "flat", value: 0 },
      discountValue: discountValue,
      additionalCharges: payload.additionalCharges || [],
      additionalChargesTotal: additionalChargesTotal,
      applyTCS: payload.applyTCS || false,
      tcs: tcs,
      taxableAmount: taxable,
      sgstTotal: sgstTotal,
      cgstTotal: cgstTotal,
      igstTotal: igstTotal,
      totalTax: totalTax,
      
      // Rounding information
      roundingApplied: payload.roundingApplied || false,
      originalTotal: payload.originalTotal || calculatedTotal,
      roundedTotal: payload.roundedTotal || finalTotal,
      roundingDifference: payload.roundingDifference || (payload.roundingApplied ? (finalTotal - calculatedTotal) : 0),
      
      amountReceived: payload.amountReceived || 0,
      paymentMode: payload.paymentMode || "Cash",
      paymentTerms: payload.paymentTerms || "",
      bankDetails: payload.bankDetails || null,
      billingAddress: payload.billingAddress || "",
      shippingAddress: payload.shippingAddress || "",
      deliveryAddress: payload.deliveryAddress || "",
      poNumber: payload.poNumber || "",
      ewayBillNumber: payload.ewayBillNumber || "",
      deliveryTerms: payload.deliveryTerms || "",
      shippingMethod: payload.shippingMethod || "",
      notes: payload.notes || [],
      orderStatus: payload.orderStatus || "draft",
      priority: payload.priority || "medium",

      // Project information
      projectId: payload.projectId || null,
      projectName: payload.projectName || null,

      // Invoice number information
      isManualInvoice: isManualInvoice,
      invoicePrefix: invoicePrefix,
      generatedInvoiceNumber: newGeneratedNumber
    };

    // Update main order record
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
      WHERE id = ? AND type = 'purchase_order'`,
      [
        invoicePrefix,
        newInvoiceSequence,
        newGeneratedNumber,
        isManualInvoice,
        originalSequence,
        sequenceStr,
        formattedDate,
        formattedDueDate,
        payload.clientId,
        payload.status || "draft",
        subtotal,
        totalTax,
        payload.totalDiscountAmount || discountValue,
        payload.total ?? finalTotal,
        JSON.stringify(payload.notes || []),
        payload.signature || null,
        JSON.stringify(meta),
        payload.projectId || null,
        req.params.id,
      ]
    );

    // Delete existing items and insert new ones
    await conn.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);

    // Track item changes
    changes.items = {
      from: `Previous items count`,
      to: `${payload.items.length} items`
    };

    // Insert updated items with tax type
    for (const item of payload.items) {
      const amounts = calculateItemAmounts(item, taxType);

      // Validate if item exists in items table
      let validItemId = null;
      if (item.itemId) {
        try {
          const [itemCheck] = await conn.execute(
            "SELECT id FROM items WHERE id = ?",
            [item.itemId]
          );
          if (itemCheck.length > 0) {
            validItemId = item.itemId;
          } else {
            console.warn(`Item with ID ${item.itemId} not found in items table`);
          }
        } catch (error) {
          console.error(`Error checking item ${item.itemId}:`, error);
        }
      }

      // Create item meta with tax type
      const itemMeta = {
        taxType: taxType,
        sgst: taxType === 'sgst_cgst' ? (item.sgst || 9) : 0,
        cgst: taxType === 'sgst_cgst' ? (item.cgst || 9) : 0,
        igst: taxType === 'igst' ? (item.igst || 18) : 0,
        sgstAmount: amounts.sgstAmount,
        cgstAmount: amounts.cgstAmount,
        igstAmount: amounts.igstAmount,
        taxableAmount: amounts.taxableAmount
      };

      await conn.execute(
        `INSERT INTO invoice_items 
        (invoiceId, itemId, description, hsn, uom, quantity, rate, discount, tax, taxAmount, amount, meta) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.params.id,
          validItemId,
          item.description,
          item.hsn || '',
          item.uom || '',
          item.quantity,
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
    let details = `Purchase order ${newGeneratedNumber} updated`;
    if (invoiceNumberChanged) {
      details += ' - Order number changed';
    }
    if (Object.keys(changes).length > 0) {
      details += ` - ${Object.keys(changes).join(', ')} changed`;
    }

    logPurchaseOrderAction(
      req.params.id,
      'updated',
      details,
      changes,
      req
    );

    res.json({ 
      message: "Purchase order updated successfully",
      id: req.params.id,
      orderNumber: newGeneratedNumber,
      invoiceSequence: newInvoiceSequence,
      sequenceString: sequenceStr,
      isManualInvoice: isManualInvoice,
      taxType: taxType,
      total: payload.total ?? finalTotal,
      roundingApplied: payload.roundingApplied || false,
      projectId: payload.projectId || null
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error updating purchase order:", err);
    
    if (err.code === 'ER_DUP_ENTRY' || err.message.includes('Duplicate entry')) {
      res.status(400).json({ 
        message: "Order number already exists. Please use a different number.",
        error: err.message
      });
    } else {
      res.status(500).json({ 
        message: "Error updating purchase order", 
        error: err.message,
        sql: err.sql
      });
    }
  } finally {
    conn.release();
  }
};

// Delete PURCHASE ORDER with logging
exports.delete = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'purchase_order'", 
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Purchase order not found" });
    }

    const order = rows[0];

    // LOG THE DELETION ACTION BEFORE DELETING THE INVOICE
    const logData = {
      invoiceNumber: order.invoice_number_generated,
      invoiceSequence: order.invoice_sequence,
      isManualInvoice: order.is_manual_invoice,
      total: order.total,
      client: order.clientId,
      status: order.status,
      projectId: order.project_id
    };

    // Delete items first
    await conn.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);
    
    // Delete order
    const [result] = await conn.execute(
      "DELETE FROM invoices WHERE id = ? AND type = 'purchase_order'", 
      [req.params.id]
    );

    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Purchase order not found" });
    }

    await conn.commit();

    // Log the deletion
    logPurchaseOrderAction(
      req.params.id,
      'deleted',
      `Purchase order ${logData.invoiceNumber} deleted`,
      logData,
      req
    );

    res.json({ message: "Purchase order deleted successfully" });
  } catch (err) {
    await conn.rollback();
    console.error("Error deleting purchase order:", err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
};

// Update purchase order status with logging
exports.updateStatus = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'purchase_order'", 
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Purchase order not found" });
    }

    const oldOrder = rows[0];
    const { status } = req.body;

    const changes = {};
    
    // Track status changes
    if (oldOrder.status !== status) {
      changes.status = { from: oldOrder.status, to: status };
    }

    await conn.execute(
      "UPDATE invoices SET status = ?, updatedAt = NOW() WHERE id = ? AND type = 'purchase_order'",
      [status, req.params.id]
    );

    await conn.commit();

    // Log status update
    logPurchaseOrderAction(
      req.params.id,
      'status_updated',
      `Purchase order status updated from ${oldOrder.status} to ${status}`,
      changes,
      req
    );

    res.json({ message: "Purchase order status updated successfully" });
  } catch (err) {
    await conn.rollback();
    console.error("Error updating purchase order status:", err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
};

// Get purchase order stats
exports.getPurchaseOrderStats = async (req, res) => {
  try {
    const [totalCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'purchase_order'"
    );
    
    const [totalAmount] = await db.execute(
      "SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE type = 'purchase_order'"
    );
    
    const [draftCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'purchase_order' AND status = 'draft'"
    );
    
    const [confirmedCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'purchase_order' AND status = 'confirmed'"
    );

    const [cancelledCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'purchase_order' AND status = 'cancelled'"
    );

    res.json({
      totalPurchaseOrders: totalCount[0].count,
      totalAmount: totalAmount[0].total,
      draftPurchaseOrders: draftCount[0].count,
      confirmedPurchaseOrders: confirmedCount[0].count,
      cancelledPurchaseOrders: cancelledCount[0].count
    });
  } catch (err) {
    console.error("Error fetching purchase order stats:", err);
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