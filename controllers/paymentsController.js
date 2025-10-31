const db = require("../config/db");

// Create a payment in
exports.createPaymentIn = async (req, res) => {
  try {
    const { partyId, amount, date, method, reference, notes, status } = req.body;

    if (!partyId || !amount || !date || !method) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Insert payment in
    const [result] = await db.execute(
      `INSERT INTO payments (partyId, amount, date, method, reference, notes, status, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [partyId, amount, date, method, reference || null, notes || null, status || 'completed']
    );

    // Update party's outstanding balance (reduce it since payment is received)
    await db.execute(
      `UPDATE parties SET outstandingBalance = outstandingBalance - ? WHERE id = ?`,
      [amount, partyId]
    );

    res.status(201).json({
      message: "Payment in created successfully",
      paymentId: result.insertId
    });
  } catch (err) {
    console.error("Error creating payment in:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// Get all payments in
exports.getAllPaymentsIn = async (req, res) => {
  try {
    const [payments] = await db.execute(`
      SELECT pi.*, p.partyName, p.billingAddress, p.shippingAddress 
      FROM payments pi 
      LEFT JOIN parties p ON pi.partyId = p.id 
      ORDER BY pi.createdAt DESC
    `);
    res.json(payments);
  } catch (err) {
    console.error("Error fetching payments in:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// Get payment in by ID
exports.getPaymentInById = async (req, res) => {
  try {
    const { id } = req.params;
    const [payments] = await db.execute(`
      SELECT pi.*, p.partyName, p.billingAddress, p.shippingAddress 
      FROM payments pi 
      LEFT JOIN parties p ON pi.partyId = p.id 
      WHERE pi.id = ?
    `, [id]);

    if (payments.length === 0) {
      return res.status(404).json({ message: "Payment not found" });
    }

    res.json(payments[0]);
  } catch (err) {
    console.error("Error fetching payment in:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// Update payment in
exports.updatePaymentIn = async (req, res) => {
  try {
    const { id } = req.params;
    const { partyId, amount, date, method, reference, notes, status } = req.body;

    // Get old payment data
    const [oldPayments] = await db.execute(
      `SELECT partyId, amount FROM payments WHERE id = ?`,
      [id]
    );

    if (oldPayments.length === 0) {
      return res.status(404).json({ message: "Payment not found" });
    }

    const oldPayment = oldPayments[0];

    // Update payment
    await db.execute(
      `UPDATE payments 
       SET partyId = ?, amount = ?, date = ?, method = ?, reference = ?, notes = ?, status = ?, updatedAt = NOW()
       WHERE id = ?`,
      [partyId, amount, date, method, reference, notes, status, id]
    );

    // Update party outstanding balance
    if (oldPayment.partyId !== partyId || oldPayment.amount !== amount) {
      // Revert old payment effect
      await db.execute(
        `UPDATE parties SET outstandingBalance = outstandingBalance + ? WHERE id = ?`,
        [oldPayment.amount, oldPayment.partyId]
      );
      
      // Apply new payment effect
      await db.execute(
        `UPDATE parties SET outstandingBalance = outstandingBalance - ? WHERE id = ?`,
        [amount, partyId]
      );
    }

    res.json({ message: "Payment updated successfully" });
  } catch (err) {
    console.error("Error updating payment in:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// Delete payment in
exports.deletePaymentIn = async (req, res) => {
  try {
    const { id } = req.params;

    // Get payment data before deletion
    const [payments] = await db.execute(
      `SELECT partyId, amount FROM payments WHERE id = ?`,
      [id]
    );

    if (payments.length === 0) {
      return res.status(404).json({ message: "Payment not found" });
    }

    const payment = payments[0];

    // Delete payment
    await db.execute(`DELETE FROM payments WHERE id = ?`, [id]);

    // Update party outstanding balance (add back the amount)
    await db.execute(
      `UPDATE parties SET outstandingBalance = outstandingBalance + ? WHERE id = ?`,
      [payment.amount, payment.partyId]
    );

    res.json({ message: "Payment deleted successfully" });
  } catch (err) {
    console.error("Error deleting payment in:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};