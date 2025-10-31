const db = require('../config/db');

// Get all bills
exports.getAllBills = async (req, res) => {
    try {
        const [rows] = await db.query(`SELECT * FROM bills ORDER BY createdAt DESC`);
        res.json(rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Get bill by ID
exports.getBillById = async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await db.query(`SELECT * FROM bills WHERE id=?`, [id]);
        res.json(rows[0] || null);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Create a new bill
exports.createBill = async (req, res) => {
    const b = req.body;
    const id = Date.now();
    try {
        await db.query(
            `INSERT INTO bills 
            (id, partyName, invoiceNo, date, items, totalAmount, paidAmount, balance) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id, b.partyName, b.invoiceNo, b.date, JSON.stringify(b.items),
                b.totalAmount, b.paidAmount, b.balance
            ]
        );
        res.status(201).json({ message: 'Bill created', id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Update a bill
exports.updateBill = async (req, res) => {
    const { id } = req.params;
    const b = req.body;
    try {
        await db.query(
            `UPDATE bills SET partyName=?, invoiceNo=?, date=?, items=?, totalAmount=?, paidAmount=?, balance=? WHERE id=?`,
            [
                b.partyName, b.invoiceNo, b.date, JSON.stringify(b.items),
                b.totalAmount, b.paidAmount, b.balance, id
            ]
        );
        res.json({ message: 'Bill updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};

// Delete a bill
exports.deleteBill = async (req, res) => {
    const { id } = req.params;
    try {
        await db.query(`DELETE FROM bills WHERE id=?`, [id]);
        res.json({ message: 'Bill deleted' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
};
