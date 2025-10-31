const db = require('../config/db');
const bcrypt = require('bcryptjs');

exports.updatePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  try {
    // fetch user password
    const [rows] = await db.query('SELECT password FROM users WHERE id=1');
    const hashedPassword = rows[0].password;

    const valid = await bcrypt.compare(currentPassword, hashedPassword);
    if (!valid) return res.status(400).json({ message: 'Current password incorrect' });

    const newHashed = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password=? WHERE id=1', [newHashed]);

    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
