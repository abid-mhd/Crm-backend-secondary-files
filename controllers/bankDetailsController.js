const db = require("../config/db");

// Get all bank details
exports.getAllBanks = async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM bank_details ORDER BY createdAt DESC");
    res.json(rows);
  } catch (err) {
    console.error("Error fetching bank details:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Get bank details by ID
exports.getBankById = async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM bank_details WHERE id = ?", [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: "Bank details not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching bank detail:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Create new bank details
exports.createBank = async (req, res) => {
  try {
    const {
      accountHolderName,
      accountNumber,
      bankName,
      bankAddress,
      ifscCode,
      accountType,
      uanNumber,
    } = req.body;

    if (!accountHolderName || !accountNumber || !bankName || !ifscCode) {
      return res.status(400).json({ message: "Required fields are missing" });
    }

    const [result] = await db.execute(
      `INSERT INTO bank_details 
        (accountHolderName, accountNumber, bankName, bankAddress, ifscCode, accountType, uanNumber, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [accountHolderName, accountNumber, bankName, bankAddress, ifscCode, accountType, uanNumber]
    );

    const [newBank] = await db.execute("SELECT * FROM bank_details WHERE id = ?", [result.insertId]);
    res.status(201).json(newBank[0]);
  } catch (err) {
    console.error("Error creating bank details:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Update existing bank details
exports.updateBank = async (req, res) => {
  try {
    const {
      accountHolderName,
      accountNumber,
      bankName,
      bankAddress,
      ifscCode,
      accountType,
      uanNumber,
    } = req.body;

    const [result] = await db.execute(
      `UPDATE bank_details 
       SET accountHolderName=?, accountNumber=?, bankName=?, bankAddress=?, ifscCode=?, accountType=?, uanNumber=?, updatedAt=NOW()
       WHERE id=?`,
      [accountHolderName, accountNumber, bankName, bankAddress, ifscCode, accountType, uanNumber, req.params.id]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: "Bank record not found" });

    const [updated] = await db.execute("SELECT * FROM bank_details WHERE id = ?", [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    console.error("Error updating bank details:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Delete bank record
exports.deleteBank = async (req, res) => {
  try {
    const [result] = await db.execute("DELETE FROM bank_details WHERE id = ?", [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: "Bank record not found" });
    res.json({ message: "Bank record deleted successfully" });
  } catch (err) {
    console.error("Error deleting bank record:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};
