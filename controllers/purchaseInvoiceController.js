const db = require("../config/db");

// Helper functions - ONLY ONE COPY
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

// Helper function to calculate item base amount for purchase
function calculatePurchaseItemBaseAmount(item) {
  return item.quantity * item.rate;
}

// Updated helper function for purchase invoice calculations with tax type support
function calculatePurchaseItemAmounts(item, taxType = 'sgst_cgst') {
  const baseAmount = calculatePurchaseItemBaseAmount(item);
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

  const totalAmount = taxableAmount ;

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

// Helper function to log invoice actions - RUNS OUTSIDE TRANSACTION - ONLY ONE COPY
const logInvoiceAction = async (invoiceId, action, details, changes = {}, req = null) => {
  // Run in a separate connection to avoid transaction locks
  setImmediate(async () => {
    try {
      const userName = req?.user?.name || 'System';
      const userId = req?.user?.id || null;
      const ipAddress = req?.ip || req?.connection?.remoteAddress || null;
      const userAgent = req?.get('user-agent') || null;

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
    } catch (err) {
      console.error("Error logging invoice action:", err);
      // Don't throw - logging should not break the main operation
    }
  });
};

// Get next purchase invoice number
exports.getNextPurchaseInvoiceNumber = async (req, res) => {
  try {
    const [purchaseInvoices] = await db.execute(`
      SELECT invoiceNumber FROM invoices 
      WHERE type = 'purchase' 
      ORDER BY createdAt DESC 
      LIMIT 1
    `);

    let nextNumber = "0001";
    
    if (purchaseInvoices.length > 0) {
      const lastInvoiceNumber = purchaseInvoices[0].invoiceNumber;
      const matches = lastInvoiceNumber.match(/\d+/g);
      if (matches && matches.length > 0) {
        const lastNumber = parseInt(matches[matches.length - 1]);
        nextNumber = (lastNumber + 1).toString().padStart(4, '0');
      }
    }

    res.json({ nextNumber });
  } catch (err) {
    console.error("Error generating purchase invoice number:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// List all PURCHASE invoices with supplier + items
exports.list = async (req, res) => {
  try {
    const [invoices] = await db.execute(`
      SELECT i.*, p.partyName as clientName
      FROM invoices i
      LEFT JOIN parties p ON i.clientId = p.id
      WHERE i.type = 'purchase'
      ORDER BY i.createdAt DESC
    `);

    for (const inv of invoices) {
      const [items] = await db.execute(
        "SELECT * FROM invoice_items WHERE invoiceId = ?",
        [inv.id]
      );
      
      // Parse meta data for each item
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
          }
        } else {
          item.meta = {};
        }
        return item;
      });

      // Parse invoice meta data
      if (inv.meta && typeof inv.meta === 'string') {
        try {
          inv.meta = JSON.parse(inv.meta);
        } catch (parseError) {
          console.warn(`Failed to parse meta for purchase invoice ${inv.id}:`, parseError);
          inv.meta = {};
        }
      } else if (!inv.meta) {
        inv.meta = {};
      }
    }

    res.json(invoices);
  } catch (err) {
    console.error("Error fetching purchase invoices:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get single PURCHASE invoice by ID
exports.get = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'purchase'",
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Purchase invoice not found" });

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

    const [supplier] = await db.execute(
      "SELECT * FROM parties WHERE id = ?",
      [invoice.clientId]
    );
    invoice.supplier = supplier[0] || null;

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
        }
      } else {
        item.meta = {};
      }
      return item;
    });

    res.json(invoice);
  } catch (err) {
    console.error("Error fetching purchase invoice:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get history logs for a purchase invoice
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

// Create PURCHASE invoice with tax type support
exports.create = async (req, res) => {
  const payload = req.body;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    console.log("Creating purchase invoice with tax type:", payload.taxType);

    // Get tax type from payload or determine from supplier address
    let taxType = payload.taxType || 'sgst_cgst';
    
    // If tax type not provided, determine from supplier address
    if (!payload.taxType && payload.shippingAddress) {
      const pincode = extractPincode(payload.shippingAddress);
      const isTN = isTamilNaduPincode(pincode);
      taxType = isTN ? 'sgst_cgst' : 'igst';
    }

    // Calculate subtotal
    const subtotal = payload.items.reduce((sum, item) => {
      return sum + (item.quantity * item.rate);
    }, 0);
    
    const discountValue = payload.discount && payload.discount.type === "percent" && payload.discount.value
      ? (subtotal * parseFloat(payload.discount.value)) / 100 
      : parseFloat(payload.discount?.value || 0);
    
    const additionalChargesTotal = payload.additionalCharges?.reduce((sum, charge) => sum + charge.amount, 0) || 0;
    
    const taxable = subtotal - discountValue + additionalChargesTotal;
    const tcs = payload.applyTCS ? taxable * 0.01 : 0;
    
    // Calculate total tax, SGST, CGST, and IGST from items based on tax type
    let totalTax = 0;
    let sgstTotal = 0;
    let cgstTotal = 0;
    let igstTotal = 0;

    payload.items.forEach(item => {
      const amounts = calculatePurchaseItemAmounts(item, taxType);
      totalTax += amounts.taxAmount;
      sgstTotal += amounts.sgstAmount;
      cgstTotal += amounts.cgstAmount;
      igstTotal += amounts.igstAmount;
    });
    
    const total = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;

    // Create meta object with tax type and new fields
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
      amountPaid: payload.amountPaid || 0,
      paymentMode: payload.paymentMode || "Cash",
      paymentTerms: payload.paymentTerms || "",
      bankDetails: payload.bankDetails || null,
      billingAddress: payload.billingAddress || "",
      shippingAddress: payload.shippingAddress || "",
      poNumber: payload.poNumber || "",
      ewayBillNumber: payload.ewayBillNumber || "",
      poDate: payload.poDate || null
    };

    const [result] = await conn.execute(
      `INSERT INTO invoices 
      (invoiceNumber, date, dueDate, clientId, status, subTotal, tax, discount, total, notes, signature, type, meta, createdAt, updatedAt) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        payload.invoiceNumber,
        payload.date,
        payload.dueDate,
        payload.clientId,
        payload.status || "draft",
        subtotal,
        totalTax,
        payload.totalDiscountAmount || discountValue,
        payload.total || total,
        JSON.stringify(payload.notes || []),
        payload.signature || null,
        'purchase',
        JSON.stringify(meta)
      ]
    );

    const invoiceId = result.insertId;

    // Insert items with tax type support
    for (const item of payload.items) {
      const amounts = calculatePurchaseItemAmounts(item, taxType);

      // Create item meta with tax information based on tax type
      const itemMeta = {
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
        (invoiceId, description, hsn, uom, quantity, rate, discount, tax, taxAmount, amount, meta) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId,
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

    // THEN log the action OUTSIDE the transaction
    logInvoiceAction(
      invoiceId,
      'created',
      `Purchase invoice ${payload.invoiceNumber} created with tax type: ${taxType}`,
      {
        invoiceNumber: payload.invoiceNumber,
        supplier: payload.clientId,
        total: total,
        items: payload.items.length,
        taxType: taxType,
        status: payload.status || "draft"
      },
      req
    );

    res.status(201).json({ 
      message: "Purchase invoice created successfully", 
      id: invoiceId,
      invoiceNumber: payload.invoiceNumber,
      taxType: taxType
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error creating purchase invoice:", err);
    res.status(500).json({ message: "Error creating purchase invoice", error: err.message });
  } finally {
    conn.release();
  }
};

// Update PURCHASE invoice
exports.update = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'purchase'", 
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Purchase invoice not found" });
    }

    const oldInvoice = rows[0];
    const payload = req.body;

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

    // Get tax type from payload
    const taxType = payload.taxType || 'sgst_cgst';

    // Calculate subtotal
    const subtotal = payload.items.reduce((sum, item) => {
      return sum + (item.quantity * item.rate);
    }, 0);
    
    const discountValue = payload.discount && payload.discount.type === "percent" && payload.discount.value
      ? (subtotal * parseFloat(payload.discount.value)) / 100 
      : parseFloat(payload.discount?.value || 0);
    
    const additionalChargesTotal = payload.additionalCharges?.reduce((sum, charge) => sum + charge.amount, 0) || 0;
    
    const taxable = subtotal - discountValue + additionalChargesTotal;
    const tcs = payload.applyTCS ? taxable * 0.01 : 0;
    
    // Calculate total tax, SGST, CGST, and IGST from items based on tax type
    let totalTax = 0;
    let sgstTotal = 0;
    let cgstTotal = 0;
    let igstTotal = 0;

    payload.items.forEach(item => {
      const amounts = calculatePurchaseItemAmounts(item, taxType);
      totalTax += amounts.taxAmount;
      sgstTotal += amounts.sgstAmount;
      cgstTotal += amounts.cgstAmount;
      igstTotal += amounts.igstAmount;
    });
    
    const total = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;

    // Track changes for history log
    const changes = {};
    
    // Compare basic fields
    if (oldInvoice.status !== payload.status) {
      changes.status = { from: oldInvoice.status, to: payload.status };
    }
    if (parseFloat(oldInvoice.total).toFixed(2) !== parseFloat(total).toFixed(2)) {
      changes.total = { from: parseFloat(oldInvoice.total), to: parseFloat(total) };
    }
    if (oldInvoice.invoiceNumber !== payload.invoiceNumber) {
      changes.invoiceNumber = { from: oldInvoice.invoiceNumber, to: payload.invoiceNumber };
    }
    if (oldInvoice.clientId !== payload.clientId) {
      changes.supplier = { from: oldInvoice.clientId, to: payload.clientId };
    }

    // Parse old meta to compare tax type
    let oldTaxType = 'sgst_cgst';
    if (oldInvoice.meta) {
      try {
        const oldMeta = typeof oldInvoice.meta === 'string' ? JSON.parse(oldInvoice.meta) : oldInvoice.meta;
        oldTaxType = oldMeta.taxType || 'sgst_cgst';
      } catch (e) {
        console.error("Error parsing old invoice meta:", e);
      }
    }

    if (oldTaxType !== taxType) {
      changes.taxType = { from: oldTaxType, to: taxType };
    }

    // Create meta object for purchase invoice with new fields
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
      amountPaid: payload.amountPaid || 0,
      paymentMode: payload.paymentMode || "Cash",
      paymentTerms: payload.paymentTerms || "",
      bankDetails: payload.bankDetails || null,
      billingAddress: payload.billingAddress || "",
      shippingAddress: payload.shippingAddress || "",
      poNumber: payload.poNumber || "",
      ewayBillNumber: payload.ewayBillNumber || "",
      poDate: formattedPoDate
    };

    // Update main purchase invoice record
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
      WHERE id=? AND type='purchase'`,
      [
        payload.invoiceNumber,
        formattedDate,
        formattedDueDate,
        payload.clientId,
        payload.status || "draft",
        subtotal,
        totalTax,
        payload.totalDiscountAmount || discountValue,
        payload.total,
        JSON.stringify(payload.notes || []),
        payload.signature || null,
        JSON.stringify(meta),
        req.params.id,
      ]
    );

    // Delete existing items and insert new ones
    await conn.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);

    // Insert updated items
    for (const item of payload.items) {
      const amounts = calculatePurchaseItemAmounts(item, taxType);

      // Create item meta
      const itemMeta = {
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
        (invoiceId, description, hsn, uom, quantity, rate, discount, tax, taxAmount, amount, meta) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.params.id,
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

    // THEN log the update OUTSIDE the transaction
    let details = `Purchase invoice ${payload.invoiceNumber} updated`;
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
      message: "Purchase invoice updated successfully",
      id: req.params.id,
      invoiceNumber: payload.invoiceNumber
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error updating purchase invoice:", err);
    res.status(500).json({ 
      message: "Error updating purchase invoice", 
      error: err.message,
      sql: err.sql
    });
  } finally {
    conn.release();
  }
};

// Delete PURCHASE invoice
exports.delete = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'purchase'", 
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Purchase invoice not found" });

    const invoice = rows[0];

    // Delete items first
    await db.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);
    
    // Delete invoice
    const [result] = await db.execute(
      "DELETE FROM invoices WHERE id = ? AND type = 'purchase'", 
      [req.params.id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: "Purchase invoice not found" });

    // Log the deletion AFTER successful deletion
    logInvoiceAction(
      req.params.id,
      'deleted',
      `Purchase invoice ${invoice.invoiceNumber} deleted`,
      {
        invoiceNumber: invoice.invoiceNumber,
        total: invoice.total,
        supplier: invoice.clientId
      },
      req
    );

    res.json({ message: "Purchase invoice deleted successfully" });
  } catch (err) {
    console.error("Error deleting purchase invoice:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get balance (paid vs unpaid) for PURCHASE invoices
exports.balance = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'purchase'", 
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Purchase invoice not found" });

    const invoice = rows[0];

    const [payments] = await db.execute("SELECT * FROM payments WHERE invoiceId = ?", [invoice.id]);
    const paid = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

    const balance = +(parseFloat(invoice.total) - paid).toFixed(2);

    res.json({ 
      invoiceId: invoice.id, 
      total: invoice.total, 
      paid: +paid.toFixed(2), 
      balance 
    });
  } catch (err) {
    console.error("Error calculating balance for purchase invoice:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get purchase invoice stats
exports.getPurchaseInvoiceStats = async (req, res) => {
  try {
    const [totalCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'purchase'"
    );
    
    const [totalAmount] = await db.execute(
      "SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE type = 'purchase'"
    );
    
    const [paidCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'purchase' AND status = 'paid'"
    );
    
    const [draftCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'purchase' AND status = 'draft'"
    );

    res.json({
      totalPurchaseInvoices: totalCount[0].count,
      totalAmount: totalAmount[0].total,
      paidPurchaseInvoices: paidCount[0].count,
      draftPurchaseInvoices: draftCount[0].count
    });
  } catch (err) {
    console.error("Error fetching purchase invoice stats:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Update payment status for purchase invoice
exports.updatePaymentStatus = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'purchase'", 
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Purchase invoice not found" });
    }

    const oldInvoice = rows[0];
    const { amountPaid, status } = req.body;

    // Parse old meta
    let oldMeta = {};
    if (oldInvoice.meta) {
      try {
        oldMeta = typeof oldInvoice.meta === 'string' ? JSON.parse(oldInvoice.meta) : oldInvoice.meta;
      } catch (e) {
        console.error("Error parsing old invoice meta:", e);
      }
    }

    const changes = {};
    
    // Track amount paid changes
    if (parseFloat(oldMeta.amountPaid || 0) !== parseFloat(amountPaid || 0)) {
      changes.amountPaid = { 
        from: parseFloat(oldMeta.amountPaid || 0), 
        to: parseFloat(amountPaid || 0) 
      };
    }

    // Track status changes
    if (oldInvoice.status !== status) {
      changes.status = { from: oldInvoice.status, to: status };
    }

    // Update meta with new payment information
    const updatedMeta = {
      ...oldMeta,
      amountPaid: parseFloat(amountPaid || 0),
      paymentMode: req.body.paymentMode || oldMeta.paymentMode || "Cash"
    };

    await conn.execute(
      `UPDATE invoices SET 
        status = ?, 
        meta = ?, 
        updatedAt = NOW() 
      WHERE id = ? AND type = 'purchase'`,
      [status, JSON.stringify(updatedMeta), req.params.id]
    );

    await conn.commit();

    // Log payment status update
    logInvoiceAction(
      req.params.id,
      'payment_updated',
      `Payment status updated for purchase invoice ${oldInvoice.invoiceNumber}`,
      changes,
      req
    );

    res.json({ 
      message: "Payment status updated successfully",
      invoiceId: req.params.id,
      status: status,
      amountPaid: amountPaid
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