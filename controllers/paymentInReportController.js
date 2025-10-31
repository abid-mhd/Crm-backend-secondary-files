const db = require("../config/db");

exports.getAllPaymentsIn = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT * FROM payments_in ORDER BY paymentDate DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching payments in:", err);
    res.status(500).json({ error: err.message });
  }
};
