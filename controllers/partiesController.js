const db = require("../config/db");

// Get all parties
exports.getParties = async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT * FROM parties ORDER BY createdAt DESC");
    res.json(rows);
  } catch (err) {
    console.error("Error fetching parties:", err);
    res.status(500).json({ message: "Error fetching parties" });
  }
};

// Get single party by ID
exports.getParty = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.execute("SELECT * FROM parties WHERE id = ?", [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ message: "Party not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching party:", err);
    res.status(500).json({ message: "Error fetching party", error: err.message });
  }
};

// Get party by client ID (alias for getParty - useful for your invoice use case)
exports.getPartyByClientId = async (req, res) => {
  try {
    const { clientId } = req.params;

    const [rows] = await db.execute("SELECT * FROM parties WHERE id = ?", [clientId]);
    
    if (rows.length === 0) {
      return res.status(404).json({ message: "Party not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching party by client ID:", err);
    res.status(500).json({ message: "Error fetching party", error: err.message });
  }
};

exports.checkEmail = async (req, res) => {
  try {
    const { email } = req.query;
    const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);

    if (rows.length > 0) {
      return res.json({ exists: true });
    } else {
      return res.json({ exists: false });
    }
  } catch (error) {
    console.error("Error checking email:", error);
    res.status(500).json({ error: "Server error" });
  }
};


const safeValue = (val, defaultValue = null) => val === undefined ? defaultValue : val;

// Create party
exports.createParty = async (req, res) => {
  try {
    const {
      partyName,
      mobile,
      email,
      balance,
      balanceType,
      gstin,
      pan,
      partyType,
      category,
      billingAddress,
      shippingAddress,
      creditPeriodValue,
      creditPeriodUnit,
      creditLimit,
      bankName,
      accountNumber,
      ifsc,
      branch,
    } = req.body;

    // Validate required fields
    if (!partyName || !mobile || !email || !partyType || !category) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Helper function to safely convert values
    const safeNumber = (val, defaultValue = 0) => {
      if (val === '' || val === null || val === undefined) return defaultValue;
      const num = Number(val);
      return isNaN(num) ? defaultValue : num;
    };

    const safeString = (val, defaultValue = null) => {
      if (val === '' || val === null || val === undefined) return defaultValue;
      return String(val);
    };

    // Set default balanceType if not provided
    const defaultBalanceType = balanceType || null;

    const [result] = await db.execute(
      `INSERT INTO parties 
      (partyName, mobile, email, balance, balanceType, gstin, pan, partyType, category, 
       billingAddress, shippingAddress, creditPeriodValue, creditPeriodUnit, creditLimit, 
       bankName, accountNumber, ifsc, branch, createdAt, updatedAt) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        safeString(partyName),
        safeString(mobile),
        safeString(email),
        safeNumber(balance, 0),
        defaultBalanceType, // Use default if not provided
        safeString(gstin),
        safeString(pan),
        safeString(partyType),
        safeString(category),
        safeString(billingAddress),
        safeString(shippingAddress),
        safeNumber(creditPeriodValue, 0),
        safeString(creditPeriodUnit),
        safeNumber(creditLimit, 0),
        safeString(bankName),
        safeString(accountNumber),
        safeString(ifsc),
        safeString(branch),
      ]
    );

    res.status(201).json({ message: "Party created successfully", id: result.insertId });
  } catch (err) {
    console.error("Error creating party:", err);
    res.status(500).json({ message: "Error creating party", error: err.message });
  }
};

// Update party
exports.updateParty = async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch existing
    const [rows] = await db.execute("SELECT * FROM parties WHERE id = ?", [id]);
    if (rows.length === 0) return res.status(404).json({ message: "Party not found" });

    const {
      partyName,
      mobile,
      email,
      balance,
      balanceType,
      gstin,
      pan,
      partyType,
      category,
      billingAddress,
      shippingAddress,
      creditPeriodValue,
      creditPeriodUnit,
      creditLimit,
      bankName,
      accountNumber,
      ifsc,
      branch,
    } = req.body;

    // Helper function to safely convert values
    const safeNumber = (val, defaultValue = 0) => {
      if (val === '' || val === null || val === undefined) return defaultValue;
      const num = Number(val);
      return isNaN(num) ? defaultValue : num;
    };

    const safeString = (val, defaultValue = null) => {
      if (val === '' || val === null || val === undefined) return defaultValue;
      return String(val);
    };

    // Use existing balanceType if not provided in update
    const finalBalanceType = balanceType || rows[0].balanceType;

    await db.execute(
      `UPDATE parties 
       SET partyName=?, mobile=?, email=?, balance=?, balanceType=?, gstin=?, pan=?, 
           partyType=?, category=?, billingAddress=?, shippingAddress=?, creditPeriodValue=?, 
           creditPeriodUnit=?, creditLimit=?, bankName=?, accountNumber=?, ifsc=?, branch=?, 
           updatedAt=NOW()
       WHERE id=?`,
      [
        safeString(partyName),
        safeString(mobile),
        safeString(email),
        safeNumber(balance, 0),
        finalBalanceType,
        safeString(gstin),
        safeString(pan),
        safeString(partyType),
        safeString(category),
        safeString(billingAddress),
        safeString(shippingAddress),
        safeNumber(creditPeriodValue, 0),
        safeString(creditPeriodUnit),
        safeNumber(creditLimit, 0),
        safeString(bankName),
        safeString(accountNumber),
        safeString(ifsc),
        safeString(branch),
        id,
      ]
    );

    res.json({ message: "Party updated successfully" });
  } catch (err) {
    console.error("Error updating party:", err);
    res.status(500).json({ message: "Error updating party", error: err.message });
  }
};

// Delete party (enhanced version checking multiple dependencies)
exports.deleteParty = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if party exists
    const [partyRows] = await db.execute("SELECT * FROM parties WHERE id = ?", [id]);
    if (partyRows.length === 0) {
      return res.status(404).json({ message: "Party not found" });
    }

    // Check for dependencies
    const [invoiceRows] = await db.execute("SELECT COUNT(*) as count FROM invoices WHERE clientId = ?", [id]);
    const invoiceCount = invoiceRows[0].count;

    // Add other dependency checks if needed (e.g., estimates, payments, etc.)
    // const [estimateRows] = await db.execute("SELECT COUNT(*) as count FROM estimates WHERE partyId = ?", [id]);
    // const estimateCount = estimateRows[0].count;

    if (invoiceCount > 0) {
      return res.status(400).json({ 
        message: `Cannot delete party. This party has ${invoiceCount} invoice(s) associated with it.` 
      });
    }

    // If you have multiple dependency checks:
    // if (invoiceCount > 0 || estimateCount > 0) {
    //   return res.status(400).json({ 
    //     message: `Cannot delete party. This party has ${invoiceCount} invoice(s) and ${estimateCount} estimate(s) associated with it.` 
    //   });
    // }

    // If no dependencies, proceed with deletion
    await db.execute("DELETE FROM parties WHERE id = ?", [id]);

    res.json({ message: "Party deleted successfully" });
  } catch (err) {
    console.error("Error deleting party:", err);
    res.status(500).json({ message: "Error deleting party", error: err.message });
  }
};