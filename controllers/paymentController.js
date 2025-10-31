const db = require('../config/db');

exports.getPaymentConfig = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM payment_gateways WHERE userId=1');
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updatePaymentConfig = async (req, res) => {
  const { razorpayKeyId, razorpayKeySecret, enabled } = req.body;
  try {
    await db.query(
      'UPDATE payment_gateways SET keyId=?, keySecret=?, enabled=? WHERE userId=1',
      [razorpayKeyId, razorpayKeySecret, enabled]
    );
    res.json({ message: 'Payment configuration updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
