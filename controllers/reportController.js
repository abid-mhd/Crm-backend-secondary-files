const db = require("../config/db");

exports.getReportSummary = async (req, res) => {
  try {
    const [partyCount] = await db.execute("SELECT COUNT(*) AS total FROM parties");
    const [invoiceCount] = await db.execute("SELECT COUNT(*) AS total FROM invoices");
    const [itemCount] = await db.execute("SELECT COUNT(*) AS total FROM items");
    const [paymentInCount] = await db.execute("SELECT COUNT(*) AS total FROM payments_in");
    const [paymentOutCount] = await db.execute("SELECT COUNT(*) AS total FROM payments_out");

    res.json({
      partyReports: partyCount[0].total,
      invoiceReports: invoiceCount[0].total,
      itemReports: itemCount[0].total,
      paymentInReports: paymentInCount[0].total,
      paymentOutReports: paymentOutCount[0].total,
    });
  } catch (err) {
    console.error("Error fetching report summary:", err);
    res.status(500).json({ error: err.message });
  }
};
