const db = require('../config/db');

exports.getAppearance = async (req, res) => {
  try {
    const [rows] = await db.query('SELECT theme FROM appearance WHERE userId=1');
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateAppearance = async (req, res) => {
  const { theme } = req.body;
  try {
    await db.query('UPDATE appearance SET theme=? WHERE userId=1', [theme]);
    res.json({ message: 'Appearance updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
