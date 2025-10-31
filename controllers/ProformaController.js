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

// Helper function to calculate item base amount
function calculateItemBaseAmount(item) {
  return item.quantity * item.rate;
}

// Updated helper function for proforma calculations with tax type support
function calculateProformaItemAmounts(item, taxType = 'sgst_cgst') {
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

/* ---------- Controller Methods ---------- */

// Get next proforma invoice number
exports.getNextProformaNumber = async (req, res) => {
  try {
    const [proformaInvoices] = await db.execute(`
      SELECT invoiceNumber FROM invoices 
      WHERE type = 'proforma' 
      ORDER BY createdAt DESC 
      LIMIT 1
    `);

    let nextNumber = "0001";
    
    if (proformaInvoices.length > 0) {
      const lastInvoiceNumber = proformaInvoices[0].invoiceNumber;
      // Extract the numeric part from the last invoice number
      const matches = lastInvoiceNumber.match(/\d+/g);
      if (matches && matches.length > 0) {
        const lastNumber = parseInt(matches[matches.length - 1]);
        nextNumber = (lastNumber + 1).toString().padStart(4, '0');
      }
    }

    res.json({ nextNumber });
  } catch (err) {
    console.error("Error generating proforma number:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// List all PROFORMA invoices with client + items
exports.list = async (req, res) => {
  try {
    const [invoices] = await db.execute(`
      SELECT i.*, c.partyName as clientName
      FROM invoices i
      LEFT JOIN parties c ON i.clientId = c.id
      WHERE i.type = 'proforma'
      ORDER BY i.createdAt DESC
    `);

    for (const inv of invoices) {
      const [items] = await db.execute(
        "SELECT * FROM invoice_items WHERE invoiceId = ?",
        [inv.id]
      );
      inv.items = items;
      
      // Safely parse meta data
      if (inv.meta && typeof inv.meta === 'string') {
        try {
          inv.meta = JSON.parse(inv.meta);
        } catch (parseError) {
          console.warn(`Failed to parse meta for proforma ${inv.id}:`, parseError);
          inv.meta = {};
        }
      } else if (!inv.meta) {
        inv.meta = {};
      }
    }

    res.json(invoices);
  } catch (err) {
    console.error("Error fetching proforma invoices:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get single PROFORMA invoice by ID
exports.get = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'proforma'",
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Proforma invoice not found" });

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

    const [client] = await db.execute(
      "SELECT * FROM parties WHERE id = ?",
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
        }
      } else {
        item.meta = {};
      }
      return item;
    });

    res.json(invoice);
  } catch (err) {
    console.error("Error fetching proforma invoice:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Create PROFORMA invoice with tax type support
exports.create = async (req, res) => {
  const payload = req.body;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    console.log("Creating proforma invoice with tax type:", payload.taxType);

    // Get tax type from payload or determine from party address
    let taxType = payload.taxType || 'sgst_cgst';
    
    // If tax type not provided, determine from party address
    if (!payload.taxType && payload.shippingAddress) {
      const pincode = extractPincode(payload.shippingAddress);
      const isTN = isTamilNaduPincode(pincode);
      taxType = isTN ? 'sgst_cgst' : 'igst';
    }

    console.log("Creating proforma invoice with items:", JSON.stringify(payload.items, null, 2));

    // Calculate subtotal using the helper function
    const subtotal = payload.items.reduce((sum, item) => {
      return sum + calculateItemBaseAmount(item);
    }, 0);
    
    console.log("Calculated subtotal:", subtotal);

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
      const amounts = calculateProformaItemAmounts(item, taxType);
      totalTax += amounts.taxAmount;
      sgstTotal += amounts.sgstAmount;
      cgstTotal += amounts.cgstAmount;
      igstTotal += amounts.igstAmount;
    });

    console.log("Tax totals - totalTax:", totalTax, "sgstTotal:", sgstTotal, "cgstTotal:", cgstTotal, "igstTotal:", igstTotal);
    
    const total = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;
    console.log("Final total:", total);

    // Create meta object with tax type and additional fields
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
      validityDate: payload.validityDate || null,
      proformaStatus: payload.proformaStatus || "active",
      signature: payload.signature || null
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
        'proforma',
        JSON.stringify(meta)
      ]
    );

    const invoiceId = result.insertId;

    // Insert items with tax type support
    for (const item of payload.items) {
      const amounts = calculateProformaItemAmounts(item, taxType);

      console.log(`Item: ${item.description}`, {
        quantity: item.quantity,
        rate: item.rate,
        baseAmount: amounts.baseAmount,
        totalAmount: amounts.totalAmount,
        taxType: taxType,
        sgstAmount: amounts.sgstAmount,
        cgstAmount: amounts.cgstAmount,
        igstAmount: amounts.igstAmount
      });

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
          item.discountAmount || 0,
          parseFloat((item.tax || 0).toFixed(2)),
          parseFloat(amounts.taxAmount.toFixed(2)),
          parseFloat(amounts.totalAmount.toFixed(2)),
          JSON.stringify(itemMeta)
        ]
      );
    }

    await conn.commit();

    res.status(201).json({ 
      message: "Proforma invoice created successfully", 
      id: invoiceId,
      invoiceNumber: payload.invoiceNumber,
      taxType: taxType
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error creating proforma invoice:", err);
    res.status(500).json({ message: "Error creating proforma invoice", error: err.message });
  } finally {
    conn.release();
  }
};

// Update PROFORMA invoice with tax type support
exports.update = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'proforma'", 
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Proforma invoice not found" });
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
    const formattedValidityDate = formatDateForMySQL(payload.validityDate);

    // Get tax type from payload
    const taxType = payload.taxType || 'sgst_cgst';

    // Calculate subtotal using the helper function
    const subtotal = payload.items.reduce((sum, item) => {
      return sum + calculateItemBaseAmount(item);
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
      const amounts = calculateProformaItemAmounts(item, taxType);
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
      poDate: formattedPoDate,
      validityDate: formattedValidityDate,
      proformaStatus: payload.proformaStatus || "active",
      signature: payload.signature || null
    };

    // Update main invoice record
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
      WHERE id=? AND type='proforma'`,
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
      const amounts = calculateProformaItemAmounts(item, taxType);

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
      message: "Proforma invoice updated successfully",
      id: req.params.id,
      invoiceNumber: payload.invoiceNumber
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error updating proforma invoice:", err);
    res.status(500).json({ 
      message: "Error updating proforma invoice", 
      error: err.message,
      sql: err.sql
    });
  } finally {
    conn.release();
  }
};

// Delete PROFORMA invoice
exports.delete = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'proforma'", 
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Proforma invoice not found" });
    }

    await conn.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);
    const [result] = await conn.execute(
      "DELETE FROM invoices WHERE id = ? AND type = 'proforma'", 
      [req.params.id]
    );

    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Proforma invoice not found" });
    }

    await conn.commit();

    res.json({ message: "Proforma invoice deleted successfully" });
  } catch (err) {
    await conn.rollback();
    console.error("Error deleting proforma invoice:", err);
    res.status(500).json({ message: "Database error" });
  } finally {
    conn.release();
  }
};

// Convert proforma to sales invoice
exports.convertToSales = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    // Get proforma invoice
    const [proformaRows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'proforma'", 
      [req.params.id]
    );
    if (proformaRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Proforma invoice not found" });
    }

    const proforma = proformaRows[0];
    const meta = JSON.parse(proforma.meta || '{}');

    // Generate new sales invoice number
    const salesInvoiceNumber = proforma.invoiceNumber.replace('PROFORMA', 'INV') || `INV-${Date.now()}`;

    // Create sales invoice
    const [result] = await conn.execute(
      `INSERT INTO invoices 
      (invoiceNumber, date, dueDate, clientId, status, subTotal, tax, discount, total, notes, signature, type, meta, createdAt, updatedAt) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        salesInvoiceNumber,
        new Date().toISOString().split('T')[0], // Current date for sales invoice
        proforma.dueDate,
        proforma.clientId,
        'draft',
        proforma.subTotal,
        proforma.tax,
        proforma.discount,
        proforma.total,
        proforma.notes,
        proforma.signature,
        'sales',
        JSON.stringify({ ...meta, convertedFrom: proforma.id })
      ]
    );

    const salesInvoiceId = result.insertId;

    // Copy items
    const [items] = await conn.execute(
      "SELECT * FROM invoice_items WHERE invoiceId = ?",
      [proforma.id]
    );

    for (const item of items) {
      await conn.execute(
        `INSERT INTO invoice_items 
        (invoiceId, description, hsn, uom, quantity, rate, discount, tax, taxAmount, amount, meta) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          salesInvoiceId,
          item.description,
          item.hsn,
          item.uom,
          item.quantity,
          item.rate,
          item.discount,
          item.tax,
          item.taxAmount,
          item.amount,
          item.meta
        ]
      );
    }

    // Update proforma status to converted
    const updatedMeta = { ...meta, proformaStatus: 'converted', convertedTo: salesInvoiceId };
    await conn.execute(
      "UPDATE invoices SET meta = ? WHERE id = ?",
      [JSON.stringify(updatedMeta), proforma.id]
    );

    await conn.commit();

    res.json({ 
      message: "Proforma invoice converted to sales invoice", 
      proformaId: proforma.id,
      salesInvoiceId: salesInvoiceId,
      salesInvoiceNumber: salesInvoiceNumber
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error converting proforma to sales:", err);
    res.status(500).json({ message: "Error converting proforma to sales", error: err.message });
  } finally {
    conn.release();
  }
};