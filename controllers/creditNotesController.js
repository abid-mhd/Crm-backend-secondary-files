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

// Updated helper function for credit note calculations
function calculateCreditNoteItemAmounts(item, taxType = 'sgst_cgst') {
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

// Get next credit note number
exports.getNextCreditNoteNumber = async (req, res) => {
  try {
    const [creditNotes] = await db.execute(`
      SELECT invoiceNumber FROM invoices 
      WHERE type = 'credit' 
      ORDER BY createdAt DESC 
      LIMIT 1
    `);

    let nextNumber = "0001";
    
    if (creditNotes.length > 0) {
      const lastInvoiceNumber = creditNotes[0].invoiceNumber;
      // Extract the numeric part from the last invoice number
      const matches = lastInvoiceNumber.match(/\d+/g);
      if (matches && matches.length > 0) {
        const lastNumber = parseInt(matches[matches.length - 1]);
        nextNumber = (lastNumber + 1).toString().padStart(4, '0');
      }
    }

    res.json({ nextNumber });
  } catch (err) {
    console.error("Error generating credit note number:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get all CREDIT NOTES with client + items
exports.getAllCreditNotes = async (req, res) => {
  try {
    const [creditNotes] = await db.execute(`
      SELECT i.*, c.name as clientName
      FROM invoices i
      LEFT JOIN clients c ON i.clientId = c.id
      WHERE i.type = 'credit'
      ORDER BY i.createdAt DESC
    `);

    for (const cn of creditNotes) {
      const [items] = await db.execute(
        "SELECT * FROM invoice_items WHERE invoiceId = ?",
        [cn.id]
      );
      cn.items = items;
      
      // Safely parse meta data - only if it's a string
      if (cn.meta && typeof cn.meta === 'string') {
        try {
          cn.meta = JSON.parse(cn.meta);
        } catch (parseError) {
          console.warn(`Failed to parse meta for credit note ${cn.id}:`, parseError);
          cn.meta = {};
        }
      } else if (!cn.meta) {
        cn.meta = {};
      }
    }

    res.json(creditNotes);
  } catch (err) {
    console.error("Error fetching credit notes:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get single CREDIT NOTE by ID
exports.getCreditNoteById = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'credit'",
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Credit note not found" });

    const creditNote = rows[0];

    // Safely parse meta data
    if (creditNote.meta && typeof creditNote.meta === 'string') {
      try {
        creditNote.meta = JSON.parse(creditNote.meta);
      } catch (parseError) {
        console.warn(`Failed to parse meta for credit note ${creditNote.id}:`, parseError);
        creditNote.meta = {};
      }
    } else if (!creditNote.meta) {
      creditNote.meta = {};
    }

    const [client] = await db.execute(
      "SELECT * FROM clients WHERE id = ?",
      [creditNote.clientId]
    );
    creditNote.client = client[0] || null;

    const [items] = await db.execute(
      "SELECT * FROM invoice_items WHERE invoiceId = ?",
      [creditNote.id]
    );
    
    // Parse meta data for each item
    creditNote.items = items.map(item => {
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

    res.json(creditNote);
  } catch (err) {
    console.error("Error fetching credit note:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Create CREDIT NOTE with tax type support
exports.createCreditNote = async (req, res) => {
  const payload = req.body;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    console.log("Creating credit note with tax type:", payload.taxType);

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

    const totalItemDiscount = payload.items.reduce((sum, item) => {
    let baseAmount;
    
    
      baseAmount = item.quantity * item.sellingPrice;

    
    const discountAmount = item.discount ? (baseAmount * item.discount) / 100 : 0;
    return sum + discountAmount;
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
      const amounts = calculateCreditNoteItemAmounts(item, taxType);
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
      creditNoteReason: payload.creditNoteReason || "",
      originalInvoiceNumber: payload.originalInvoiceNumber || "",
      creditType: payload.creditType || "sales_return"
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
        'credit',
        JSON.stringify(meta)
      ]
    );

    const creditNoteId = result.insertId;

    // Insert items with tax type support
    for (const item of payload.items) {
      const amounts = calculateCreditNoteItemAmounts(item, taxType);

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
          creditNoteId,
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
      message: "Credit note created successfully", 
      id: creditNoteId,
      invoiceNumber: payload.invoiceNumber,
      taxType: taxType
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error creating credit note:", err);
    res.status(500).json({ message: "Error creating credit note", error: err.message });
  } finally {
    conn.release();
  }
};

// Update CREDIT NOTE
exports.updateCreditNote = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    // Check if credit note exists
    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'credit'", 
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Credit note not found" });
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
      const amounts = calculateCreditNoteItemAmounts(item, taxType);
      totalTax += amounts.taxAmount;
      sgstTotal += amounts.sgstAmount;
      cgstTotal += amounts.cgstAmount;
      igstTotal += amounts.igstAmount;
    });
    
    const total = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;

    // Create meta object for credit note
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
      creditNoteReason: payload.creditNoteReason || "",
      originalInvoiceNumber: payload.originalInvoiceNumber || "",
      creditType: payload.creditType || "sales_return"
    };

    // Update main credit note record
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
      WHERE id=? AND type='credit'`,
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
      const amounts = calculateCreditNoteItemAmounts(item, taxType);

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
      message: "Credit note updated successfully",
      id: req.params.id,
      invoiceNumber: payload.invoiceNumber
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error updating credit note:", err);
    res.status(500).json({ 
      message: "Error updating credit note", 
      error: err.message
    });
  } finally {
    conn.release();
  }
};

// Delete CREDIT NOTE
exports.deleteCreditNote = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    // Check if credit note exists
    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'credit'", 
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Credit note not found" });
    }

    // Delete items first
    await conn.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);
    
    // Delete credit note
    const [result] = await conn.execute(
      "DELETE FROM invoices WHERE id = ? AND type = 'credit'", 
      [req.params.id]
    );

    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Credit note not found" });
    }

    await conn.commit();

    res.json({ message: "Credit note deleted successfully" });
  } catch (err) {
    await conn.rollback();
    console.error("Error deleting credit note:", err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
};

// Get balance for CREDIT NOTE
exports.getCreditNoteBalance = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'credit'", 
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Credit note not found" });

    const creditNote = rows[0];

    const [payments] = await db.execute("SELECT * FROM payments WHERE invoiceId = ?", [creditNote.id]);
    const paid = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

    const balance = +(parseFloat(creditNote.total) - paid).toFixed(2);

    res.json({ 
      creditNoteId: creditNote.id, 
      total: creditNote.total, 
      paid: +paid.toFixed(2), 
      balance 
    });
  } catch (err) {
    console.error("Error calculating balance for credit note:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get credit note stats
exports.getCreditNoteStats = async (req, res) => {
  try {
    const [totalCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'credit'"
    );
    
    const [totalAmount] = await db.execute(
      "SELECT COALESCE(SUM(total), 0) as total FROM invoices WHERE type = 'credit'"
    );
    
    const [paidCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'credit' AND status = 'paid'"
    );
    
    const [draftCount] = await db.execute(
      "SELECT COUNT(*) as count FROM invoices WHERE type = 'credit' AND status = 'draft'"
    );

    res.json({
      totalCreditNotes: totalCount[0].count,
      totalAmount: totalAmount[0].total,
      paidCreditNotes: paidCount[0].count,
      draftCreditNotes: draftCount[0].count
    });
  } catch (err) {
    console.error("Error fetching credit note stats:", err);
    res.status(500).json({ message: "Database error" });
  }
};