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
  
  // If it's a URL (like localhost), return null to avoid storing URLs
  if (typeof signatureData === 'string' && signatureData.startsWith('http')) {
    console.warn('Signature is a URL, expecting base64 data URL. Please convert signature to base64 on frontend.');
    return null;
  }
  
  return signatureData;
};

// List all SALES invoices with client + items
exports.list = async (req, res) => {
  try {
    const [invoices] = await db.execute(`
      SELECT i.*, c.name as clientName
      FROM invoices i
      LEFT JOIN clients c ON i.clientId = c.id
      WHERE i.type = 'sales'
      ORDER BY i.createdAt DESC
    `);

    for (const inv of invoices) {
      const [items] = await db.execute(
        "SELECT * FROM invoice_items WHERE invoiceId = ?",
        [inv.id]
      );
      inv.items = items;
    }

    res.json(invoices);
  } catch (err) {
    console.error("Error fetching sales invoices:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get single SALES invoice by ID
exports.get = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'sales'",
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

    // Add tax type to invoice response
    invoice.taxType = taxType;

    res.json(invoice);
  } catch (err) {
    console.error("Error fetching sales invoice:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Create SALES invoice with items
exports.create = async (req, res) => {
  const payload = req.body;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    console.log("Creating invoice with items:", JSON.stringify(payload.items, null, 2));
    console.log("Tax Type:", payload.taxType);

    // Get tax type from payload
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

    console.log("Tax totals - taxType:", taxType, "totalTax:", totalTax, "sgstTotal:", sgstTotal, "cgstTotal:", cgstTotal, "igstTotal:", igstTotal);
    
    const total = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;
    console.log("Final total:", total);

    // Create meta object for additional fields with tax type
    const meta = {
      taxType: taxType, // Save tax type in meta
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
        signatureBase64, // Store base64 signature instead of URL
        'sales',
        JSON.stringify(meta)
      ]
    );

    const invoiceId = result.insertId;

    // Insert items with correct amount calculations
    for (const item of payload.items) {
      const amounts = calculateItemAmounts(item, taxType);

      console.log(`Item: ${item.description}`, {
        isPercentageQty: item.isPercentageQty,
        percentageValue: item.percentageValue,
        quantity: item.quantity,
        rate: item.rate,
        baseAmount: amounts.baseAmount,
        totalAmount: amounts.totalAmount,
        taxType: taxType
      });

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
        (item.percentageValue || 0) : // Store percentage value
        item.quantity;

      // Insert item with productId
      await conn.execute(
        `INSERT INTO invoice_items 
        (invoiceId, description, hsn, uom, quantity, rate, discount, tax, taxAmount, amount, meta) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId,
          // item.id || null, 
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
      signatureSaved: !!signatureBase64
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error creating sales invoice:", err);
    res.status(500).json({ message: "Error creating sales invoice", error: err.message });
  } finally {
    conn.release();
  }
};

// Update SALES invoice
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

    const payload = req.body;

    // Get tax type from payload
    const taxType = payload.taxType || 'sgst_cgst';

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
      poDate: formattedPoDate
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
        payload.total,
        JSON.stringify(payload.notes || []),
        signatureBase64, // Store base64 signature instead of URL
        JSON.stringify(meta),
        req.params.id,
      ]
    );

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
      signatureUpdated: !!signatureBase64
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error updating sales invoice:", err);
    res.status(500).json({ 
      message: "Error updating sales invoice", 
      error: err.message,
      sql: err.sql
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