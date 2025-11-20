const db = require("../config/db");

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

// Get next purchase order number
exports.getNextPurchaseOrderNumber = async (req, res) => {
  try {
    const [purchaseOrders] = await db.execute(`
      SELECT invoiceNumber FROM invoices 
      WHERE type = 'purchase_order' 
      ORDER BY createdAt DESC 
      LIMIT 1
    `);

    let nextNumber = "0001";
    
    if (purchaseOrders.length > 0) {
      const lastInvoiceNumber = purchaseOrders[0].invoiceNumber;
      // Extract the numeric part from the last invoice number
      const matches = lastInvoiceNumber.match(/\d+/g);
      if (matches && matches.length > 0) {
        const lastNumber = parseInt(matches[matches.length - 1]);
        nextNumber = (lastNumber + 1).toString().padStart(4, '0');
      }
    }

    res.json({ nextNumber });
  } catch (err) {
    console.error("Error generating purchase order number:", err);
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
      const [items] = await db.execute(
        "SELECT * FROM invoice_items WHERE invoiceId = ?",
        [order.id]
      );
      
      // Parse meta data for order
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

      // Parse meta data for each item
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
        return item;
      });
    }

    res.json(orders);
  } catch (err) {
    console.error("Error fetching purchase orders:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get single PURCHASE ORDER by ID
exports.get = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'purchase_order'",
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

    const [items] = await db.execute(
      "SELECT * FROM invoice_items WHERE invoiceId = ?",
      [order.id]
    );
    
    // Parse meta data for each item
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
      return item;
    });

    res.json(order);
  } catch (err) {
    console.error("Error fetching purchase order:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Create PURCHASE ORDER with items
exports.create = async (req, res) => {
  const payload = req.body;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    console.log("Creating purchase order with tax type:", payload.taxType);

    // Get tax type from payload or determine from supplier address
    let taxType = payload.taxType || 'sgst_cgst';
    
    // If tax type not provided, determine from supplier address
    if (!payload.taxType && payload.shippingAddress) {
      const pincode = extractPincode(payload.shippingAddress);
      const isTN = isTamilNaduPincode(pincode);
      taxType = isTN ? 'sgst_cgst' : 'igst';
    }

    console.log("Using tax type:", taxType);

    // Calculate subtotal using the helper function
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

    console.log("Tax totals - totalTax:", totalTax, "sgstTotal:", sgstTotal, "cgstTotal:", cgstTotal, "igstTotal:", igstTotal);
    
    // Apply rounding if enabled
    const calculatedTotal = taxable + tcs + totalTax + sgstTotal + cgstTotal + igstTotal;
    const finalTotal = payload.roundingApplied ? Math.round(calculatedTotal) : calculatedTotal;
    
    console.log("Final total:", finalTotal, "Rounding applied:", payload.roundingApplied);

    // Create meta object for purchase order specific fields with tax type
    const meta = {
      // Tax type information
      taxType: taxType,
      
      // Order information
      orderNumber: payload.orderNumber || "",
      orderDate: payload.orderDate || payload.date,
      expectedDeliveryDate: payload.expectedDeliveryDate || "",
      
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
      priority: payload.priority || "medium"
    };

    const [result] = await conn.execute(
      `INSERT INTO invoices 
      (invoiceNumber, date, dueDate, clientId, status, subTotal, tax, discount, total, notes, signature, type, meta, createdAt, updatedAt) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        payload.invoiceNumber,
        payload.date,
        payload.dueDate || payload.expectedDeliveryDate,
        payload.clientId,
        payload.status || "draft",
        subtotal,
        totalTax,
        payload.totalDiscountAmount || discountValue,
        payload.total ?? calculatedTotal, // Use the final rounded total here
        JSON.stringify(payload.notes || []),
        payload.signature || null,
        'purchase_order',
        JSON.stringify(meta)
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
        (invoiceId, description, hsn, uom, quantity, rate, discount, tax, taxAmount, amount, meta) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderId,
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
      message: "Purchase order created", 
      id: orderId,
      orderNumber: payload.invoiceNumber,
      taxType: taxType,
      total: payload.total ?? calculatedTotal,
      roundingApplied: payload.roundingApplied || false
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error creating purchase order:", err);
    res.status(500).json({ message: "Error creating purchase order", error: err.message });
  } finally {
    conn.release();
  }
};

// Update PURCHASE ORDER
exports.update = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    // Check if order exists
    const [rows] = await conn.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'purchase_order'", 
      [req.params.id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Purchase order not found" });
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
    const formattedExpectedDeliveryDate = formatDateForMySQL(payload.expectedDeliveryDate);

    // Get tax type from payload
    const taxType = payload.taxType || 'sgst_cgst';

    // Calculate subtotal using the helper function
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
      orderNumber: payload.orderNumber || "",
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
      priority: payload.priority || "medium"
    };

    // Update main order record
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
      WHERE id=? AND type='purchase_order'`,
      [
        payload.invoiceNumber,
        formattedDate,
        formattedDueDate,
        payload.clientId,
        payload.status || "draft",
        subtotal,
        totalTax,
        payload.totalDiscountAmount || discountValue,
        payload.total ?? calculatedTotal, // Use the final rounded total here
        JSON.stringify(payload.notes || []),
        payload.signature || null,
        JSON.stringify(meta),
        req.params.id,
      ]
    );

    // Delete existing items and insert new ones
    await conn.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);

    // Insert updated items with tax type
    for (const item of payload.items) {
      const amounts = calculateItemAmounts(item, taxType);

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
      message: "Purchase order updated successfully",
      id: req.params.id,
      orderNumber: payload.invoiceNumber,
      taxType: taxType,
      total: payload.total ??calculatedTotal,
      roundingApplied: payload.roundingApplied || false
    });
  } catch (err) {
    await conn.rollback();
    console.error("Error updating purchase order:", err);
    res.status(500).json({ 
      message: "Error updating purchase order", 
      error: err.message
    });
  } finally {
    conn.release();
  }
};

// Delete PURCHASE ORDER
exports.delete = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ? AND type = 'purchase_order'", 
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: "Purchase order not found" });

    await db.execute("DELETE FROM invoice_items WHERE invoiceId = ?", [req.params.id]);
    const [result] = await db.execute(
      "DELETE FROM invoices WHERE id = ? AND type = 'purchase_order'", 
      [req.params.id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: "Purchase order not found" });

    res.json({ message: "Purchase order deleted" });
  } catch (err) {
    console.error("Error deleting purchase order:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Update purchase order status
exports.updateStatus = async (req, res) => {
  try {
    const { status } = req.body;
    
    const [result] = await db.execute(
      "UPDATE invoices SET status = ?, updatedAt = NOW() WHERE id = ? AND type = 'purchase_order'",
      [status, req.params.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Purchase order not found" });
    }

    res.json({ message: "Purchase order status updated successfully" });
  } catch (err) {
    console.error("Error updating purchase order status:", err);
    res.status(500).json({ message: "Database error" });
  }
};