const db = require("../config/db");

/* ---------- Helper Functions ---------- */
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

// Valid status values for delivery challan
const VALID_STATUS = ['draft', 'pending', 'delivered', 'partial', 'cancelled'];

// Utility function to validate status
function validateStatus(status) {
  return VALID_STATUS.includes(status) ? status : 'draft';
}

// Utility function to sanitize values
function sanitizeValue(value) {
  if (value === undefined || value === '') {
    return null;
  }
  return value;
}

// Helper function to safely parse meta data
function safeParseMeta(metaData) {
  if (!metaData) {
    return {};
  }
  
  if (typeof metaData === 'object') {
    return metaData;
  }
  
  if (typeof metaData === 'string') {
    try {
      return JSON.parse(metaData);
    } catch (e) {
      console.error("Error parsing meta data:", e);
      return {};
    }
  }
  
  return {};
}

// Helper function to calculate item base amount
function calculateItemBaseAmount(item) {
  return item.quantity * item.rate;
}

// Updated helper function for delivery challan calculations with tax type support
function calculateDeliveryChallanItemAmounts(item, taxType = 'sgst_cgst') {
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

// Format date for MySQL
function formatDateForMySQL(dateString) {
  if (!dateString) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    return dateString;
  }
  if (dateString.includes('T')) {
    return dateString.split('T')[0];
  }
  return new Date(dateString).toISOString().split('T')[0];
}

// List all delivery challans
exports.list = async (req, res) => {
  try {
    const [challans] = await db.execute(`
      SELECT i.*, c.name as clientName
      FROM invoices i
      LEFT JOIN clients c ON i.clientId = c.id
      WHERE i.type = 'delivery_challan'
      ORDER BY i.createdAt DESC
    `);

    for (const challan of challans) {
      const [items] = await db.execute(
        "SELECT * FROM invoice_items WHERE invoiceId = ?",
        [challan.id]
      );
      challan.items = items;

      // Safely parse meta data
      challan.meta = safeParseMeta(challan.meta);
    }

    res.json({
      success: true,
      data: challans,
      count: challans.length
    });
  } catch (err) {
    console.error("Error fetching delivery challans:", err);
    res.status(500).json({ 
      success: false,
      message: "Database error",
      error: err.message 
    });
  }
};

// Get single delivery challan by ID
exports.get = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'delivery_challan'",
      [req.params.id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Delivery challan not found" 
      });
    }

    const challan = rows[0];

    // Get client details
    const [client] = await db.execute(
      "SELECT id, name, address FROM clients WHERE id = ?",
      [challan.clientId]
    );
    challan.client = client[0] || null;

    // Get items
    const [items] = await db.execute(
      "SELECT * FROM invoice_items WHERE invoiceId = ?",
      [challan.id]
    );
    
    // Parse meta data for each item
    challan.items = items.map(item => {
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
        }
      } else {
        item.meta = {};
      }
      return item;
    });

    // Safely parse meta data
    challan.meta = safeParseMeta(challan.meta);

    res.json({
      success: true,
      data: challan
    });
  } catch (err) {
    console.error("Error fetching delivery challan:", err);
    res.status(500).json({ 
      success: false,
      message: "Database error",
      error: err.message 
    });
  }
};

// Create delivery challan with tax type support
exports.create = async (req, res) => {
  const payload = req.body;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    console.log("Creating delivery challan with payload:", payload);

    // Get tax type from payload or determine from party address
    let taxType = payload.taxType || 'sgst_cgst';
    
    // If tax type not provided, determine from party address
    if (!payload.taxType && payload.shippingAddress) {
      const pincode = extractPincode(payload.shippingAddress);
      const isTN = isTamilNaduPincode(pincode);
      taxType = isTN ? 'sgst_cgst' : 'igst';
    }

    console.log("Determined tax type:", taxType);

    // Auto-determine status based on amount received
    const payloadTotal = parseFloat(payload.total) || 0;
    const amountReceived = parseFloat(payload.amountReceived) || 0;
    
    let finalStatus = payload.status || 'draft';
    if (amountReceived >= payloadTotal) {
      finalStatus = 'delivered';
    } else if (amountReceived > 0) {
      finalStatus = 'partial';
    } else {
      finalStatus = 'pending';
    }

    console.log("Determined status:", finalStatus);

    // Calculate subtotal
    const subtotal = payload.items?.reduce((sum, item) => {
      return sum + (item.quantity * item.rate);
    }, 0) || 0;
    
    const discountValue = payload.discount && payload.discount.type === "percent" && payload.discount.value
      ? (subtotal * (parseFloat(payload.discount.value) || 0)) / 100 
      : (parseFloat(payload.discount?.value) || 0);
    
    const additionalChargesTotal = payload.additionalCharges?.reduce((sum, charge) => sum + (charge.amount || 0), 0) || 0;
    
    const taxable = subtotal - discountValue + additionalChargesTotal;
    const tcs = payload.applyTCS ? taxable * 0.01 : 0;
    
    // Calculate total tax, SGST, CGST, and IGST from items based on tax type
    let totalTax = 0;
    let sgstTotal = 0;
    let cgstTotal = 0;
    let igstTotal = 0;

    payload.items?.forEach(item => {
      const amounts = calculateDeliveryChallanItemAmounts(item, taxType);
      totalTax += amounts.taxAmount;
      sgstTotal += amounts.sgstAmount;
      cgstTotal += amounts.cgstAmount;
      igstTotal += amounts.igstAmount;
    }) || 0;
    
    const grandTotal = payload.total;

    console.log("Calculated totals:", {
      subtotal,
      discountValue,
      additionalChargesTotal,
      taxable,
      tcs,
      totalTax,
      sgstTotal,
      cgstTotal,
      igstTotal,
      grandTotal
    });

    // Create meta object for additional fields with proper defaults
    const meta = {
      // Tax information
      taxType: taxType,
      
      // Discount information
      discount: payload.discount || { type: "flat", value: 0 },
      discountValue: discountValue,
      
      // Additional charges
      additionalCharges: payload.additionalCharges || [],
      additionalChargesTotal: additionalChargesTotal,
      
      // TCS information
      applyTCS: payload.applyTCS || false,
      tcs: tcs,
      taxableAmount: taxable,
      
      // GST information
      sgstTotal: sgstTotal,
      cgstTotal: cgstTotal,
      igstTotal: igstTotal,
      totalTax: totalTax,
      
      // Payment information
      amountReceived: payload.amountReceived || 0,
      paymentMode: payload.paymentMode || "Cash",
      paymentTerms: payload.paymentTerms || "",
      
      // Bank details
      bankDetails: payload.bankDetails || null,
      
      // Address information
      billingAddress: payload.billingAddress || "",
      shippingAddress: payload.shippingAddress || "",
      
      // Other fields
      poNumber: payload.poNumber || "",
      ewayBillNumber: payload.ewayBillNumber || "",
      poDate: payload.poDate || null,
      
      // Delivery specific fields
      deliveryDate: payload.deliveryDate || null,
      vehicleNumber: payload.vehicleNumber || "",
      dispatchedThrough: payload.dispatchedThrough || ""
    };

    // Prepare all parameters with proper null handling
    const insertParams = [
      sanitizeValue(payload.invoiceNumber),
      sanitizeValue(formatDateForMySQL(payload.date)),
      sanitizeValue(formatDateForMySQL(payload.dueDate)),
      sanitizeValue(payload.clientId),
      finalStatus,
      subtotal || 0,
      totalTax || 0,
      payload.totalDiscountAmount || discountValue,
      grandTotal || 0,
      JSON.stringify(payload.notes || []),
      sanitizeValue(payload.signature),
      'delivery_challan',
      JSON.stringify(meta)
    ];

    console.log('Insert Parameters:', insertParams);

    // Insert main delivery challan record into invoices table
    const [result] = await conn.execute(
      `INSERT INTO invoices 
      (invoiceNumber, date, dueDate, clientId, status, subTotal, tax, discount, total, 
       notes, signature, type, meta, createdAt, updatedAt) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      insertParams
    );

    const challanId = result.insertId;

    // Insert items into invoice_items table
    if (payload.items && payload.items.length > 0) {
      for (const item of payload.items) {
        const amounts = calculateDeliveryChallanItemAmounts(item, taxType);

        // Create item meta for GST
        const itemMeta = {
          sgst: taxType === 'sgst_cgst' ? (item.sgst || 9) : 0,
          cgst: taxType === 'sgst_cgst' ? (item.cgst || 9) : 0,
          igst: taxType === 'igst' ? (item.igst || 18) : 0,
          sgstAmount: parseFloat(amounts.sgstAmount.toFixed(2)),
          cgstAmount: parseFloat(amounts.cgstAmount.toFixed(2)),
          igstAmount: parseFloat(amounts.igstAmount.toFixed(2)),
          taxableAmount: parseFloat(amounts.taxableAmount.toFixed(2))
        };

        const itemParams = [
          challanId,
          sanitizeValue(item.description) || '',
          sanitizeValue(item.hsn) || '',
          sanitizeValue(item.uom) || '',
          item.quantity || 0,
          item.rate || 0,
          parseFloat((item.discountAmount || 0).toFixed(2)),
          item.tax || 0,
          amounts.taxAmount || 0,
          amounts.totalAmount || 0,
          JSON.stringify(itemMeta)
        ];

        await conn.execute(
          `INSERT INTO invoice_items 
          (invoiceId, description, hsn, uom, quantity, rate, discount, tax, taxAmount, amount, meta) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          itemParams
        );
      }
    }

    await conn.commit();

    res.status(201).json({ 
      success: true,
      message: "Delivery challan created successfully", 
      data: {
        id: challanId,
        invoiceNumber: payload.invoiceNumber,
        status: finalStatus,
        taxType: taxType
      }
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error creating delivery challan:", err);
    res.status(500).json({ 
      success: false,
      message: "Error creating delivery challan", 
      error: err.message,
      sqlState: err.sqlState
    });
  } finally {
    conn.release();
  }
};

// Update delivery challan with tax type support
exports.update = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    // Check if delivery challan exists
    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'delivery_challan'", 
      [req.params.id]
    );
    
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ 
        success: false,
        message: "Delivery challan not found" 
      });
    }

    const payload = req.body;

    // Get tax type from payload or determine from party address
    let taxType = payload.taxType || 'sgst_cgst';
    
    // If tax type not provided, determine from party address
    if (!payload.taxType && payload.shippingAddress) {
      const pincode = extractPincode(payload.shippingAddress);
      const isTN = isTamilNaduPincode(pincode);
      taxType = isTN ? 'sgst_cgst' : 'igst';
    }

    // Validate status
    const status = validateStatus(payload.status);

    // Format dates to YYYY-MM-DD for MySQL
    const formattedDate = formatDateForMySQL(payload.date);
    const formattedDueDate = formatDateForMySQL(payload.dueDate);
    const formattedPoDate = formatDateForMySQL(payload.poDate);
    const formattedDeliveryDate = formatDateForMySQL(payload.deliveryDate);

    // Calculate subtotal
    const subtotal = payload.items?.reduce((sum, item) => {
      return sum + (item.quantity * item.rate);
    }, 0) || 0;
    
    const discountValue = payload.discount && payload.discount.type === "percent" && payload.discount.value
      ? (subtotal * (parseFloat(payload.discount.value) || 0)) / 100 
      : (parseFloat(payload.discount?.value) || 0);
    
    const additionalChargesTotal = payload.additionalCharges?.reduce((sum, charge) => sum + (charge.amount || 0), 0) || 0;
    
    const taxable = subtotal - discountValue + additionalChargesTotal;
    const tcs = payload.applyTCS ? taxable * 0.01 : 0;
    
    // Calculate total tax, SGST, CGST, and IGST from items based on tax type
    let totalTax = 0;
    let sgstTotal = 0;
    let cgstTotal = 0;
    let igstTotal = 0;

    payload.items?.forEach(item => {
      const amounts = calculateDeliveryChallanItemAmounts(item, taxType);
      totalTax += amounts.taxAmount;
      sgstTotal += amounts.sgstAmount;
      cgstTotal += amounts.cgstAmount;
      igstTotal += amounts.igstAmount;
    }) || 0;
    
    const grandTotal = payload.total;

    // Create meta object
    const meta = {
      taxType: taxType,
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
      amountReceived: payload.amountReceived || 0,
      paymentMode: payload.paymentMode || "Cash",
      paymentTerms: payload.paymentTerms || "",
      bankDetails: payload.bankDetails || null,
      billingAddress: payload.billingAddress || "",
      shippingAddress: payload.shippingAddress || "",
      poNumber: payload.poNumber || "",
      ewayBillNumber: payload.ewayBillNumber || "",
      poDate: formattedPoDate,
      deliveryDate: formattedDeliveryDate,
      vehicleNumber: payload.vehicleNumber || "",
      dispatchedThrough: payload.dispatchedThrough || ""
    };

    // Prepare update parameters with proper null handling
    const updateParams = [
      sanitizeValue(payload.invoiceNumber),
      sanitizeValue(formattedDate),
      sanitizeValue(formattedDueDate),
      sanitizeValue(payload.clientId),
      status,
      subtotal || 0,
      totalTax || 0,
      payload.totalDiscountAmount || discountValue,
      grandTotal || 0,
      JSON.stringify(payload.notes || []),
      sanitizeValue(payload.signature),
      JSON.stringify(meta),
      req.params.id
    ];

    // Update main delivery challan record in invoices table
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
        updatedAt=NOW() 
      WHERE id=? AND type='delivery_challan'`,
      updateParams
    );

    // Delete existing items and insert new ones
    await conn.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);

    // Insert updated items
    if (payload.items && payload.items.length > 0) {
      for (const item of payload.items) {
        const amounts = calculateDeliveryChallanItemAmounts(item, taxType);

        // Create item meta for GST
        const itemMeta = {
          sgst: taxType === 'sgst_cgst' ? (item.sgst || 9) : 0,
          cgst: taxType === 'sgst_cgst' ? (item.cgst || 9) : 0,
          igst: taxType === 'igst' ? (item.igst || 18) : 0,
          sgstAmount: amounts.sgstAmount,
          cgstAmount: amounts.cgstAmount,
          igstAmount: amounts.igstAmount,
          taxableAmount: amounts.taxableAmount
        };

        const itemParams = [
          req.params.id,
          sanitizeValue(item.description) || '',
          sanitizeValue(item.hsn) || '',
          sanitizeValue(item.uom) || '',
          item.quantity || 0,
          item.rate || 0,
          item.discountAmount || 0,
          item.tax || 0,
          amounts.taxAmount || 0,
          amounts.totalAmount || 0,
          JSON.stringify(itemMeta)
        ];

        await conn.execute(
          `INSERT INTO invoice_items 
          (invoiceId, description, hsn, uom, quantity, rate, discount, tax, taxAmount, amount, meta) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          itemParams
        );
      }
    }

    await conn.commit();

    res.json({ 
      success: true,
      message: "Delivery challan updated successfully",
      data: {
        id: req.params.id,
        invoiceNumber: payload.invoiceNumber,
        taxType: taxType
      }
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error updating delivery challan:", err);
    res.status(500).json({ 
      success: false,
      message: "Error updating delivery challan", 
      error: err.message
    });
  } finally {
    conn.release();
  }
};

// Delete delivery challan
exports.delete = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    // Check if delivery challan exists
    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'delivery_challan'", 
      [req.params.id]
    );
    
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ 
        success: false,
        message: "Delivery challan not found" 
      });
    }

    // Delete items first
    await conn.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);
    
    // Delete main challan record
    const [result] = await conn.execute(
      "DELETE FROM invoices WHERE id = ? AND type = 'delivery_challan'", 
      [req.params.id]
    );

    await conn.commit();

    res.json({ 
      success: true,
      message: "Delivery challan deleted successfully" 
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error deleting delivery challan:", err);
    res.status(500).json({ 
      success: false,
      message: "Database error",
      error: err.message 
    });
  } finally {
    conn.release();
  }
};

// Update delivery challan status
exports.updateStatus = async (req, res) => {
  try {
    const { status } = req.body;
    
    if (!VALID_STATUS.includes(status)) {
      return res.status(400).json({ 
        success: false,
        message: "Invalid status. Valid statuses are: " + VALID_STATUS.join(', ') 
      });
    }

    const [result] = await db.execute(
      "UPDATE invoices SET status = ?, updatedAt = NOW() WHERE id = ? AND type = 'delivery_challan'",
      [status, req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Delivery challan not found" 
      });
    }

    res.json({ 
      success: true,
      message: "Delivery challan status updated successfully",
      data: { status: status }
    });
  } catch (err) {
    console.error("Error updating delivery challan status:", err);
    res.status(500).json({ 
      success: false,
      message: "Database error",
      error: err.message 
    });
  }
};

// Get delivery challan statistics
exports.getStats = async (req, res) => {
  try {
    const [stats] = await db.execute(`
      SELECT 
        status,
        COUNT(*) as count,
        SUM(total) as totalAmount
      FROM invoices 
      WHERE type = 'delivery_challan'
      GROUP BY status
    `);

    const [totalStats] = await db.execute(`
      SELECT 
        COUNT(*) as totalChallans,
        SUM(total) as totalRevenue,
        AVG(total) as averageChallanValue
      FROM invoices
      WHERE type = 'delivery_challan'
    `);

    res.json({
      success: true,
      data: {
        statusBreakdown: stats,
        totals: totalStats[0]
      }
    });
  } catch (err) {
    console.error("Error fetching delivery challan stats:", err);
    res.status(500).json({ 
      success: false,
      message: "Database error",
      error: err.message 
    });
  }
};

// Get balance (paid vs unpaid) for delivery challans
exports.balance = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'delivery_challan'", 
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Delivery challan not found" });

    const challan = rows[0];

    const [payments] = await db.execute("SELECT * FROM payments WHERE invoiceId = ?", [challan.id]);
    const paid = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

    const balance = +(parseFloat(challan.total) - paid).toFixed(2);

    res.json({ 
      success: true,
      data: {
        challanId: challan.id, 
        total: challan.total, 
        paid: +paid.toFixed(2), 
        balance 
      }
    });
  } catch (err) {
    console.error("Error calculating balance for delivery challan:", err);
    res.status(500).json({ 
      success: false,
      message: "Database error",
      error: err.message 
    });
  }
};