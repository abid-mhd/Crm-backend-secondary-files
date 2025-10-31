// backend/controllers/itemController.js
const db = require("../config/db");

exports.getItems = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT * FROM items 
      ORDER BY createdAt DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching items:", err);
    res.status(500).json({ message: "Error fetching items" });
  }
};

exports.createItem = async (req, res) => {
  try {
    const {
      type,
      category,
      name,
      sellingPrice,
      purchasePrice,
      taxType,
      gstRate,
      measuringUnit,
      stock,
      code,
      hsnCode,
      asOfDate,
      description
    } = req.body;

    // Validation
    if (!name  || !code || !measuringUnit || !hsnCode || !asOfDate) {
      return res.status(400).json({ 
        message: "Required fields: name, code, measuringUnit, hsnCode, asOfDate" 
      });
    }

    const [result] = await db.execute(
      `INSERT INTO items (
        type, category, name, sellingPrice, purchasePrice, taxType, 
        gstRate, measuringUnit, stock, code, hsnCode, asOfDate, description,
        createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        type || 'Product',
        category || null,
        name,
        parseFloat(sellingPrice) || 0,
        parseFloat(purchasePrice) || 0,
        taxType || 'With Tax',
        gstRate || 'None',
        measuringUnit,
        parseInt(stock) || 0,
        code,
        hsnCode,
        asOfDate,
        description || null
      ]
    );

    res.status(201).json({ 
      message: "Item created successfully", 
      id: result.insertId 
    });
  } catch (err) {
    console.error("Error creating item:", err);
    res.status(400).json({ message: "Error creating item" });
  }
};

exports.getItem = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM items WHERE id = ?", 
      [req.params.id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ message: "Item not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching item:", err);
    res.status(500).json({ message: "Error fetching item" });
  }
};

exports.updateItem = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM items WHERE id = ?", 
      [req.params.id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ message: "Item not found" });
    }

    const {
      type,
      category,
      name,
      sellingPrice,
      purchasePrice,
      taxType,
      gstRate,
      measuringUnit,
      stock,
      code,
      hsnCode,
      asOfDate,
      description
    } = req.body;

    // Validation
    if (!name || !sellingPrice || !code || !measuringUnit || !hsnCode || !asOfDate) {
      return res.status(400).json({ 
        message: "Required fields: name, sellingPrice, code, measuringUnit, hsnCode, asOfDate" 
      });
    }

    await db.execute(
      `UPDATE items SET 
        type=?, category=?, name=?, sellingPrice=?, purchasePrice=?, taxType=?,
        gstRate=?, measuringUnit=?, stock=?, code=?, hsnCode=?, asOfDate=?, description=?,
        updatedAt=NOW() 
      WHERE id=?`,
      [
        type,
        category,
        name,
        parseFloat(sellingPrice),
        parseFloat(purchasePrice) || 0,
        taxType,
        gstRate,
        measuringUnit,
        parseInt(stock) || 0,
        code,
        hsnCode,
        asOfDate,
        description,
        req.params.id
      ]
    );

    res.json({ message: "Item updated successfully" });
  } catch (err) {
    console.error("Error updating item:", err);
    res.status(400).json({ message: "Error updating item" });
  }
};

exports.deleteItem = async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT * FROM items WHERE id = ?", 
      [req.params.id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ message: "Item not found" });
    }

    await db.execute("DELETE FROM items WHERE id = ?", [req.params.id]);

    res.json({ message: "Item deleted successfully" });
  } catch (err) {
    console.error("Error deleting item:", err);
    res.status(500).json({ message: "Error deleting item" });
  }
};