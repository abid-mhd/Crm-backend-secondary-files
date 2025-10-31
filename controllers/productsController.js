const db = require("../config/db");

// Get all products
exports.list = async (req, res) => {
  try {
    const [products] = await db.execute("SELECT * FROM products ORDER BY createdAt DESC");
    res.json(products);
  } catch (err) {
    console.error("Error fetching products:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// Create a product
exports.create = async (req, res) => {
  try {
    const { name, sku, rate, description } = req.body;

    const [result] = await db.execute(
      `INSERT INTO products (name, sku, rate, description, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [name, sku || null, rate || 0, description || null]
    );

    res.status(201).json({ message: "Product created", id: result.insertId });
  } catch (err) {
    console.error("Error creating product:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// Get a single product by ID
exports.get = async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM products WHERE id = ?", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: "Product not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching product:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// Update a product
exports.update = async (req, res) => {
  try {
    const { name, sku, rate, description } = req.body;

    const [result] = await db.execute(
      `UPDATE products SET name = ?, sku = ?, rate = ?, description = ?, updatedAt = NOW() WHERE id = ?`,
      [name, sku, rate, description, req.params.id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: "Product not found" });

    const [updated] = await db.execute("SELECT * FROM products WHERE id = ?", [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    console.error("Error updating product:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// Delete a product
exports.remove = async (req, res) => {
  try {
    const [result] = await db.execute("DELETE FROM products WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: "Product not found" });
    res.json({ message: "Product deleted successfully" });
  } catch (err) {
    console.error("Error deleting product:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};
