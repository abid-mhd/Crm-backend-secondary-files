const db = require("../config/db");

exports.getAllPaymentsOut = async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM payments_out ORDER BY createdAt DESC");
    res.json(rows);
  } catch (err) {
    console.error("Error fetching payments out:", err);
    res.status(500).json({ error: "Database error" });
  }
};

exports.getPaymentOutById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const [rows] = await db.execute("SELECT * FROM payments_out WHERE id = ?", [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ message: "Payment not found" });
    }
    
    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching payment:", err);
    res.status(500).json({ error: "Database error" });
  }
};

exports.createPaymentOut = async (req, res) => {
  try {
    const {
      partyId,
      amount,
      paymentDate,
      paymentMode,
      reference,
      notes
    } = req.body;

    const [result] = await db.execute(
      `INSERT INTO payments_out 
        (partyId, amount, paymentDate, paymentMode, reference, notes, createdAt, updatedAt) 
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [partyId, amount, paymentDate, paymentMode, reference || null, notes || null]
    );

    res.status(201).json({ message: "Payment created successfully", id: result.insertId });
  } catch (err) {
    console.error("Error creating payment:", err);
    res.status(500).json({ error: "Database error" });
  }
};

exports.updatePaymentOut = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      partyId,
      amount,
      paymentDate,
      paymentMode,
      reference,
      notes
    } = req.body;

    // Check if payment exists
    const [rows] = await db.execute("SELECT * FROM payments_out WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Payment not found" });
    }

    // Update payment
    await db.execute(
      `UPDATE payments_out 
       SET partyId = ?, amount = ?, paymentDate = ?, paymentMode = ?, 
           reference = ?, notes = ?, updatedAt = NOW() 
       WHERE id = ?`,
      [partyId, amount, paymentDate, paymentMode, reference || null, notes || null, id]
    );

    res.json({ message: "Payment updated successfully" });
  } catch (err) {
    console.error("Error updating payment:", err);
    res.status(500).json({ error: "Database error" });
  }
};

exports.deletePaymentOut = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.execute("SELECT * FROM payments_out WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Payment not found" });
    }

    await db.execute("DELETE FROM payments_out WHERE id = ?", [id]);
    res.json({ message: "Payment deleted successfully" });
  } catch (err) {
    console.error("Error deleting payment:", err);
    res.status(500).json({ error: "Database error" });
  }
};