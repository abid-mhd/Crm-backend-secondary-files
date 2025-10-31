const pool = require("../config/db");

//  List all clients
exports.list = async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM clients ORDER BY createdAt DESC");
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "Error fetching clients", error: err.message });
  }
};

//  Create a new client
exports.create = async (req, res) => {
  try {
    const { name, email, phone, address } = req.body;

    const [result] = await pool.query(
      "INSERT INTO clients (name, email, phone, address) VALUES (?, ?, ?, ?)",
      [name, email, phone, address]
    );

    res.status(201).json({ id: result.insertId, name, email, phone, address });
  } catch (err) {
    res.status(500).json({ message: "Error creating client", error: err.message });
  }
};

//  Get a single client by ID
exports.get = async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM clients WHERE id = ?", [req.params.id]);

    if (rows.length === 0) return res.status(404).json({ message: "Not found" });

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "Error fetching client", error: err.message });
  }
};

//  Update client
exports.update = async (req, res) => {
  try {
    const { name, email, phone, address } = req.body;

    const [result] = await pool.query(
      "UPDATE clients SET name = ?, email = ?, phone = ?, address = ? WHERE id = ?",
      [name, email, phone, address, req.params.id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: "Not found" });

    res.json({ message: "Client updated" });
  } catch (err) {
    res.status(500).json({ message: "Error updating client", error: err.message });
  }
};

//  Delete client
exports.remove = async (req, res) => {
  try {
    const [result] = await pool.query("DELETE FROM clients WHERE id = ?", [req.params.id]);

    if (result.affectedRows === 0) return res.status(404).json({ message: "Not found" });

    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ message: "Error deleting client", error: err.message });
  }
};
