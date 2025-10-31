// src/controllers/itemsController.js
const db = require('../config/db');

// CREATE a new items item
exports.createItem = async (req, res) => {
  try {
    const {
      name,
      code,
      stock,
      sellingPrice,
      purchasePrice,
      type,
      category,
      taxType,
      gstRate,
      measuringUnit,
      asOfDate,
      description,
    } = req.body;

    if (!name || !code || !sellingPrice || !measuringUnit) {
      return res.status(400).json({ message: 'Required fields are missing' });
    }

    const [result] = await db.execute(
      `INSERT INTO items 
      (name, code, stock, sellingPrice, purchasePrice, type, category, taxType, gstRate, measuringUnit, asOfDate, description) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        code,
        stock,
        sellingPrice || 0,
        purchasePrice || 0,
        type || 'Product',
        category || '',
        taxType || 'With Tax',
        gstRate || 'None',
        measuringUnit,
        asOfDate || null,
        description || '',
      ]
    );

    res.status(201).json({ id: result.insertId, message: 'Item created successfully' });
  } catch (error) {
    console.error('Error creating item:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// GET all items items
exports.getAllItems = async (req, res) => {
  try {
    const [rows] = await db.execute(`SELECT * FROM items ORDER BY id DESC`);
    res.status(200).json(rows);
  } catch (error) {
    console.error('Error fetching items:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// GET single item by ID
exports.getItemById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.execute(`SELECT * FROM items WHERE id = ?`, [id]);

    if (rows.length === 0) return res.status(404).json({ message: 'Item not found' });

    res.status(200).json(rows[0]);
  } catch (error) {
    console.error('Error fetching item:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// UPDATE an items item
exports.updateItem = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      code,
      stock,
      sellingPrice,
      purchasePrice,
      type,
      category,
      taxType,
      gstRate,
      measuringUnit,
      asOfDate,
      description,
    } = req.body;

    const [result] = await db.execute(
      `UPDATE items SET 
      name=?, code=?, stock=?, sellingPrice=?, purchasePrice=?, type=?, category=?, taxType=?, gstRate=?, measuringUnit=?, asOfDate=?, description=? 
      WHERE id=?`,
      [
        name,
        code,
        stock,
        sellingPrice,
        purchasePrice,
        type,
        category,
        taxType,
        gstRate,
        measuringUnit,
        asOfDate,
        description,
        id,
      ]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: 'Item not found' });

    res.status(200).json({ message: 'Item updated successfully' });
  } catch (error) {
    console.error('Error updating item:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// DELETE an item
exports.deleteItem = async (req, res) => {
  try {
    const { id } = req.params;

    // First, check if the item exists in invoice_items table
    const [invoiceItems] = await db.execute(
      `SELECT * FROM invoice_items WHERE itemId = ?`, 
      [id]
    );

    // If there are any references in invoice_items, prevent deletion
    if (invoiceItems.length > 0) {
      return res.status(400).json({ 
        message: 'Cannot delete item. It is referenced in existing invoices.' 
      });
    }

    // If no references found, proceed with deletion
    const [result] = await db.execute(`DELETE FROM items WHERE id=?`, [id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Item not found' });
    }

    res.status(200).json({ message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error deleting item:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};
