const db = require('../config/db');

exports.getProfile = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE id = 1'); // dummy user
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateProfile = async (req, res) => {
  const { firstName, lastName, email, phone, username, company, role } = req.body;
  try {
    await db.query(
      `UPDATE users SET firstName=?, lastName=?, email=?, phone=?, username=?, company=?, role=? WHERE id=1`,
      [firstName, lastName, email, phone, username, company, role]
    );
    res.json({ message: 'Profile updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
