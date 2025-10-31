const db = require("../config/db");

exports.createChallan = async (req, res) => {
  try {
    const {
      challan_no,
      date,
      customer_name,
      customer_address,
      contact_number,
      items,
      total_quantity,
      vehicle_no,
      driver_name,
      delivery_date,
      remarks,
    } = req.body;

    if (!challan_no || !customer_name) {
      return res.status(400).json({ message: "Challan number and customer name are required" });
    }

    // Insert challan
    const [challanResult] = await db.execute(
      `INSERT INTO delivery_challans 
       (challan_no, date, customer_name, customer_address, contact_number, total_quantity, vehicle_no, driver_name, delivery_date, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [challan_no, date, customer_name, customer_address, contact_number, total_quantity, vehicle_no, driver_name, delivery_date, remarks]
    );

    const challanId = challanResult.insertId;

    // Insert items
    if (items && items.length > 0) {
      for (const item of items) {
        await db.execute(
          `INSERT INTO delivery_challan_items 
           (challan_id, item_name, quantity, unit)
           VALUES (?, ?, ?, ?)`,
          [challanId, item.item_name, item.quantity, item.unit]
        );
      }
    }

    res.status(201).json({ message: "Delivery challan created successfully" });
  } catch (err) {
    console.error("Error creating delivery challan:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get all delivery challans
exports.getAllChallans = async (req, res) => {
  try {
    const [rows] = await db.execute(`SELECT * FROM delivery_challans ORDER BY date DESC`);
    res.status(200).json(rows);
  } catch (err) {
    console.error("Error fetching challans:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Get single challan with items
exports.getChallanById = async (req, res) => {
  try {
    const { id } = req.params;

    const [[challan]] = await db.execute(`SELECT * FROM delivery_challans WHERE id = ?`, [id]);
    if (!challan) return res.status(404).json({ message: "Challan not found" });

    const [items] = await db.execute(`SELECT * FROM delivery_challan_items WHERE challan_id = ?`, [id]);

    res.status(200).json({ challan, items });
  } catch (err) {
    console.error("Error fetching challan:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

// Delete challan
exports.deleteChallan = async (req, res) => {
  try {
    const { id } = req.params;

    await db.execute(`DELETE FROM delivery_challan_items WHERE challan_id = ?`, [id]);
    await db.execute(`DELETE FROM delivery_challans WHERE id = ?`, [id]);

    res.status(200).json({ message: "Challan deleted successfully" });
  } catch (err) {
    console.error("Error deleting challan:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};
