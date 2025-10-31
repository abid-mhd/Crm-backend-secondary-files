const db = require("../config/db");

exports.getAllPaymentsOut = async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT * FROM payments_out ORDER BY paymentDate DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching payments out:", err);
    res.status(500).json({ error: err.message });
  }
};
