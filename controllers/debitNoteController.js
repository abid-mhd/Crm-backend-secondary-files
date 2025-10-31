const db = require("../config/db");

// Helper functions
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

// Helper function to calculate item base amount
function calculateItemBaseAmount(item) {
  return item.quantity * item.rate;
}

// Updated helper function for debit note calculations with tax type support
function calculateDebitNoteItemAmounts(item, taxType = 'sgst_cgst') {
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

// Get next debit note number
exports.getNextDebitNoteNumber = async (req, res) => {
  try {
    const [debitNotes] = await db.execute(`
      SELECT invoiceNumber FROM invoices 
      WHERE type = 'debit' 
      ORDER BY createdAt DESC 
      LIMIT 1
    `);

    let nextNumber = "0001";
    
    if (debitNotes.length > 0) {
      const lastInvoiceNumber = debitNotes[0].invoiceNumber;
      const matches = lastInvoiceNumber.match(/\d+/g);
      if (matches && matches.length > 0) {
        const lastNumber = parseInt(matches[matches.length - 1]);
        nextNumber = (lastNumber + 1).toString().padStart(4, '0');
      }
    }

    res.json({ nextNumber });
  } catch (err) {
    console.error("Error generating debit note number:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// List all DEBIT notes with party + items
exports.list = async (req, res) => {
  try {
    const [debitNotes] = await db.execute(`
      SELECT i.*, p.partyName as clientName
      FROM invoices i
      LEFT JOIN parties p ON i.clientId = p.id
      WHERE i.type = 'debit'
      ORDER BY i.createdAt DESC
    `);

    for (const debitNote of debitNotes) {
      const [items] = await db.execute(
        "SELECT * FROM invoice_items WHERE invoiceId = ?",
        [debitNote.id]
      );
      
      debitNote.items = items.map(item => {
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

      // Parse meta data for debit note
      if (debitNote.meta && typeof debitNote.meta === 'string') {
        try {
          debitNote.meta = JSON.parse(debitNote.meta);
        } catch (parseError) {
          console.warn(`Failed to parse meta for debit note ${debitNote.id}:`, parseError);
          debitNote.meta = {};
        }
      } else if (!debitNote.meta) {
        debitNote.meta = {};
      }
    }

    res.json(debitNotes);
  } catch (err) {
    console.error("Error fetching debit notes:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get single DEBIT note by ID
exports.get = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'debit'",
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Debit note not found" });

    const debitNote = rows[0];

    // Handle meta data
    if (debitNote.meta) {
      if (typeof debitNote.meta === 'string') {
        try {
          debitNote.meta = JSON.parse(debitNote.meta);
        } catch (e) {
          console.error("Error parsing debit note meta:", e);
          debitNote.meta = {};
        }
      }
    } else {
      debitNote.meta = {};
    }

    const [party] = await db.execute(
      "SELECT * FROM parties WHERE id = ?",
      [debitNote.clientId]
    );
    debitNote.party = party[0] || null;

    const [items] = await db.execute(
      "SELECT * FROM invoice_items WHERE invoiceId = ?",
      [debitNote.id]
    );
    
    // Parse meta data for each item
    debitNote.items = items.map(item => {
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

    res.json(debitNote);
  } catch (err) {
    console.error("Error fetching debit note:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Create DEBIT note with tax type support
exports.create = async (req, res) => {
  const payload = req.body;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    console.log("Creating debit note with tax type:", payload.taxType);

    // Get tax type from payload or determine from party address
    let taxType = payload.taxType || 'sgst_cgst';
    
    // If tax type not provided, determine from party address
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
      const amounts = calculateDebitNoteItemAmounts(item, taxType);
      totalTax += amounts.taxAmount;
      sgstTotal += amounts.sgstAmount;
      cgstTotal += amounts.cgstAmount;
      igstTotal += amounts.igstAmount;
    });
    
    const total = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;

    // Create meta object with tax type
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
      amountReceived: payload.amountReceived || 0,
      paymentMode: payload.paymentMode || "Cash",
      paymentTerms: payload.paymentTerms || "",
      bankDetails: payload.bankDetails || null,
      billingAddress: payload.billingAddress || "",
      shippingAddress: payload.shippingAddress || "",
      poNumber: payload.poNumber || "",
      ewayBillNumber: payload.ewayBillNumber || "",
      poDate: payload.poDate || null,
      debitNotePrefix: payload.debitNotePrefix || "I/DN/25-26/",
      debitNoteDate: payload.debitNoteDate || payload.date
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
        payload.total,
        JSON.stringify(payload.notes || []),
        payload.signature || null,
        'debit',
        JSON.stringify(meta)
      ]
    );

    const debitNoteId = result.insertId;

    // Insert items with tax type support
    for (const item of payload.items) {
      const amounts = calculateDebitNoteItemAmounts(item, taxType);

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
          debitNoteId,
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

    await conn.commit();

    res.status(201).json({ 
      message: "Debit note created successfully", 
      id: debitNoteId,
      invoiceNumber: payload.invoiceNumber,
      taxType: taxType
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error creating debit note:", err);
    res.status(500).json({ message: "Error creating debit note", error: err.message });
  } finally {
    conn.release();
  }
};

// Update DEBIT note with tax type support
exports.update = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    // Check if debit note exists
    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'debit'", 
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Debit note not found" });
    }

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
      const amounts = calculateDebitNoteItemAmounts(item, taxType);
      totalTax += amounts.taxAmount;
      sgstTotal += amounts.sgstAmount;
      cgstTotal += amounts.cgstAmount;
      igstTotal += amounts.igstAmount;
    });
    
    const total = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;

    // Create meta object for debit note
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
      amountReceived: payload.amountReceived || 0,
      paymentMode: payload.paymentMode || "Cash",
      paymentTerms: payload.paymentTerms || "",
      bankDetails: payload.bankDetails || null,
      billingAddress: payload.billingAddress || "",
      shippingAddress: payload.shippingAddress || "",
      poNumber: payload.poNumber || "",
      ewayBillNumber: payload.ewayBillNumber || "",
      poDate: formattedPoDate,
      debitNotePrefix: payload.debitNotePrefix || "I/DN/25-26/",
      debitNoteDate: payload.debitNoteDate || formattedDate
    };

    // Update main debit note record
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
      WHERE id=? AND type='debit'`,
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
      const amounts = calculateDebitNoteItemAmounts(item, taxType);

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

    await conn.commit();

    res.json({ 
      message: "Debit note updated successfully",
      id: req.params.id,
      invoiceNumber: payload.invoiceNumber
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error updating debit note:", err);
    res.status(500).json({ 
      message: "Error updating debit note", 
      error: err.message
    });
  } finally {
    conn.release();
  }
};

// Delete DEBIT note
exports.delete = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'debit'", 
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Debit note not found" });

    await db.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);
    const [result] = await db.execute(
      "DELETE FROM invoices WHERE id = ? AND type = 'debit'", 
      [req.params.id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: "Debit note not found" });

    res.json({ message: "Debit note deleted successfully" });
  } catch (err) {
    console.error("Error deleting debit note:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get balance (received vs total) for DEBIT notes
exports.balance = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'debit'", 
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Debit note not found" });

    const debitNote = rows[0];
    const meta = JSON.parse(debitNote.meta || '{}');
    
    const received = meta.amountReceived || 0;
    const balance = +(parseFloat(debitNote.total) - received).toFixed(2);

    res.json({ 
      debitNoteId: debitNote.id, 
      total: debitNote.total, 
      received: +received.toFixed(2), 
      balance 
    });
  } catch (err) {
    console.error("Error calculating balance for debit note:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get debit note stats
exports.getDebitNoteStats = async (req, res) => {
  try {
    const [totalCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'debit'"
    );
    
    const [totalAmount] = await db.execute(
      "SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE type = 'debit'"
    );
    
    const [paidCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'debit' AND status = 'paid'"
    );
    
    const [draftCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'debit' AND status = 'draft'"
    );

    res.json({
      totalDebitNotes: totalCount[0].count,
      totalAmount: totalAmount[0].total,
      paidDebitNotes: paidCount[0].count,
      draftDebitNotes: draftCount[0].count
    });
  } catch (err) {
    console.error("Error fetching debit note stats:", err);
    res.status(500).json({ message: "Database error" });
  }
};