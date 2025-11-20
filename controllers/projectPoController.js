const db = require("../config/db");

// Get all purchase orders for a project with their items
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

    res.json({ purchaseOrders: orders });
  } catch (err) {
    console.error("Error fetching project purchase orders:", err);
    res.status(500).json({ message: "Database error" });
  }
};

// Get single purchase order with items
exports.getPurchaseOrderById = async (req, res) => {
  try {
    const { id } = req.params;

    // Get purchase order
    const [purchaseOrders] = await db.execute(
      `SELECT * FROM invoices WHERE id = ? AND type = 'purchase_order'`,
      [id]
    );

    if (purchaseOrders.length === 0) {
      return res.status(404).json({ message: "Purchase order not found" });
    }

    const purchaseOrder = purchaseOrders[0];

    // Get items for this purchase order
    const [items] = await db.execute(
      `SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC`,
      [id]
    );

    const purchaseOrderWithItems = {
      ...purchaseOrder,
      items: items || []
    };

    res.json({
      purchaseOrder: purchaseOrderWithItems
    });
  } catch (err) {
    console.error("Error fetching purchase order:", err);
    res.status(500).json({ message: "Error fetching purchase order", error: err.message });
  }
};

// Alternative optimized version that gets all data in one query
exports.getPurchaseOrdersByProjectOptimized = async (req, res) => {
  try {
    const { projectId } = req.params;

    const [results] = await db.execute(
      `SELECT 
        i.*,
        ii.id as item_id,
        ii.description as item_description,
        ii.quantity as item_quantity,
        ii.rate as item_rate,
        ii.amount as item_amount,
        ii.uom as item_uom,
        ii.taxAmount as item_taxAmount,
        ii.createdAt as item_createdAt,
        ii.updatedAt as item_updatedAt
      FROM invoices i
      LEFT JOIN invoice_items ii ON i.id = ii.invoice_id
      WHERE i.type = 'purchase_order' AND i.project_id = ?
      ORDER BY i.createdAt DESC, ii.id ASC`,
      [projectId]
    );

    // Group items by purchase order
    const purchaseOrdersMap = new Map();

    results.forEach(row => {
      const poId = row.id;
      
      if (!purchaseOrdersMap.has(poId)) {
        // Create purchase order object without item fields
        const { item_id, item_description, item_quantity, item_rate, item_amount, item_uom, item_taxAmount, item_createdAt, item_updatedAt, ...poData } = row;
        purchaseOrdersMap.set(poId, {
          ...poData,
          items: []
        });
      }

      // Add item if it exists
      if (row.item_id) {
        const po = purchaseOrdersMap.get(poId);
        po.items.push({
          id: row.item_id,
          description: row.item_description,
          quantity: row.item_quantity,
          rate: row.item_rate,
          amount: row.item_amount,
          uom: row.item_uom,
          taxAmount: row.item_taxAmount,
          createdAt: row.item_createdAt,
          updatedAt: row.item_updatedAt
        });
      }
    });

    const purchaseOrders = Array.from(purchaseOrdersMap.values());

    res.json({
      purchaseOrders: purchaseOrders,
      total: purchaseOrders.length
    });
  } catch (err) {
    console.error("Error fetching purchase orders:", err);
    res.status(500).json({ message: "Error fetching purchase orders", error: err.message });
  }
};

// Create purchase order with items
exports.createPurchaseOrder = async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();

    const {
      project_id,
      invoiceNumber,
      clientId,
      date,
      dueDate,
      items,
      subTotal,
      discount,
      taxableAmount,
      cgst,
      sgst,
      igst,
      tax,
      roundOff,
      total,
      status = 'draft',
      notes,
      meta
    } = req.body;

    // Validate required fields
    if (!project_id || !invoiceNumber || !clientId || !date) {
      return res.status(400).json({ message: "Project ID, invoice number, client ID, and date are required" });
    }

    // Insert purchase order
    const [result] = await connection.execute(
      `INSERT INTO invoices 
      (project_id, invoiceNumber, clientId, date, dueDate, subTotal, discount, taxableAmount, cgst, sgst, igst, tax, roundOff, total, status, notes, meta, type, createdAt, updatedAt) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'purchase_order', NOW(), NOW())`,
      [
        project_id,
        invoiceNumber,
        clientId,
        date,
        dueDate || null,
        subTotal || 0,
        discount || 0,
        taxableAmount || 0,
        cgst || 0,
        sgst || 0,
        igst || 0,
        tax || 0,
        roundOff || 0,
        total || 0,
        status,
        notes ? JSON.stringify(notes) : null,
        meta ? JSON.stringify(meta) : null
      ]
    );

    const invoiceId = result.insertId;

    // Insert items if provided
    if (items && Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        await connection.execute(
          `INSERT INTO invoice_items 
          (invoice_id, description, quantity, rate, amount, uom, taxAmount, createdAt, updatedAt) 
          VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            invoiceId,
            item.description || '',
            item.quantity || 0,
            item.rate || 0,
            item.amount || 0,
            item.uom || 'PCS',
            item.taxAmount || 0
          ]
        );
      }
    }

    await connection.commit();

    // Return the created purchase order with items
    const [newPurchaseOrder] = await db.execute(
      `SELECT * FROM invoices WHERE id = ?`,
      [invoiceId]
    );

    const [newItems] = await db.execute(
      `SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC`,
      [invoiceId]
    );

    res.status(201).json({ 
      message: "Purchase order created successfully", 
      purchaseOrder: {
        ...newPurchaseOrder[0],
        items: newItems || []
      }
    });

  } catch (err) {
    await connection.rollback();
    console.error("Error creating purchase order:", err);
    res.status(500).json({ message: "Error creating purchase order", error: err.message });
  } finally {
    connection.release();
  }
};

// Update purchase order with items
exports.updatePurchaseOrder = async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();

    const { id } = req.params;
    const {
      invoiceNumber,
      clientId,
      date,
      dueDate,
      items,
      subTotal,
      discount,
      taxableAmount,
      cgst,
      sgst,
      igst,
      tax,
      roundOff,
      total,
      status,
      notes,
      meta
    } = req.body;

    // Update purchase order
    await connection.execute(
      `UPDATE invoices SET 
        invoiceNumber = ?, clientId = ?, date = ?, dueDate = ?, subTotal = ?, discount = ?, taxableAmount = ?, 
        cgst = ?, sgst = ?, igst = ?, tax = ?, roundOff = ?, total = ?, status = ?, notes = ?, meta = ?, updatedAt = NOW()
      WHERE id = ? AND type = 'purchase_order'`,
      [
        invoiceNumber,
        clientId,
        date,
        dueDate || null,
        subTotal || 0,
        discount || 0,
        taxableAmount || 0,
        cgst || 0,
        sgst || 0,
        igst || 0,
        tax || 0,
        roundOff || 0,
        total || 0,
        status,
        notes ? JSON.stringify(notes) : null,
        meta ? JSON.stringify(meta) : null,
        id
      ]
    );

    // Delete existing items
    await connection.execute(
      `DELETE FROM invoice_items WHERE invoice_id = ?`,
      [id]
    );

    // Insert new items if provided
    if (items && Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        await connection.execute(
          `INSERT INTO invoice_items 
          (invoice_id, description, quantity, rate, amount, uom, taxAmount, createdAt, updatedAt) 
          VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            id,
            item.description || '',
            item.quantity || 0,
            item.rate || 0,
            item.amount || 0,
            item.uom || 'PCS',
            item.taxAmount || 0
          ]
        );
      }
    }

    await connection.commit();

    // Return the updated purchase order with items
    const [updatedPurchaseOrder] = await db.execute(
      `SELECT * FROM invoices WHERE id = ?`,
      [id]
    );

    const [updatedItems] = await db.execute(
      `SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id ASC`,
      [id]
    );

    res.json({ 
      message: "Purchase order updated successfully", 
      purchaseOrder: {
        ...updatedPurchaseOrder[0],
        items: updatedItems || []
      }
    });

  } catch (err) {
    await connection.rollback();
    console.error("Error updating purchase order:", err);
    res.status(500).json({ message: "Error updating purchase order", error: err.message });
  } finally {
    connection.release();
  }
};

// Delete purchase order with items
exports.deletePurchaseOrder = async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();

    const { id } = req.params;

    // Delete items first
    await connection.execute(
      `DELETE FROM invoice_items WHERE invoice_id = ?`,
      [id]
    );

    // Delete purchase order
    const [result] = await connection.execute(
      `DELETE FROM invoices WHERE id = ? AND type = 'purchase_order'`,
      [id]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Purchase order not found" });
    }

    await connection.commit();

    res.json({ 
      message: "Purchase order deleted successfully" 
    });

  } catch (err) {
    await connection.rollback();
    console.error("Error deleting purchase order:", err);
    res.status(500).json({ message: "Error deleting purchase order", error: err.message });
  } finally {
    connection.release();
  }
};