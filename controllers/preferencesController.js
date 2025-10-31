const db = require('../config/db');

exports.getPreferences = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM preferences WHERE userId = 1');
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updatePreferences = async (req, res) => {
  const { email, push, sms } = req.body;
  try {
    await db.query(
      `UPDATE preferences SET email=?, push=?, sms=? WHERE userId=1`,
      [email, push, sms]
    );
    res.json({ message: 'Preferences updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
