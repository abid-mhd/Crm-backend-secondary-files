const db = require("../config/db");

// Get all purchase orders for a project
exports.getSalesByProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    
    const [invoices] = await db.execute(`
      SELECT i.*, c.name as clientName, p.project_name as projectName
      FROM invoices i
      LEFT JOIN clients c ON i.clientId = c.id
      LEFT JOIN projects p ON i.project_id = p.id
      WHERE i.type = 'sales' AND i.project_id = ?
      ORDER BY i.createdAt DESC
    `, [projectId]);

    for (const inv of invoices) {
      const [items] = await db.execute(
        "SELECT * FROM invoice_items WHERE invoiceId = ?",
        [inv.id]
      );
      
      // Parse meta data for invoice
      if (inv.meta && typeof inv.meta === 'string') {
        try {
          inv.meta = JSON.parse(inv.meta);
        } catch (e) {
          console.error("Error parsing invoice meta:", e);
          inv.meta = {};
        }
      } else if (!inv.meta) {
        inv.meta = {};
      }

      inv.items = items.map(item => {
        if (item.meta) {
          if (typeof item.meta === 'string') {
            try {
              item.meta = JSON.parse(item.meta);
            } catch (e) {
              console.error("Error parsing item meta:", e);
              item.meta = {};
            }
          }
          if (typeof item.meta === 'object' && item.meta !== null) {
            item.sgst = item.meta.sgst || 9;
            item.cgst = item.meta.cgst || 9;
            item.igst = item.meta.igst || 18;
            item.sgstAmount = item.meta.sgstAmount || 0;
            item.cgstAmount = item.meta.cgstAmount || 0;
            item.igstAmount = item.meta.igstAmount || 0;
            item.percentageValue = item.meta.percentageValue || null;
            item.isPercentageQty = item.meta.isPercentageQty || false;
          }
        } else {
          item.meta = {};
        }
        return item;
      });

      // Add project information from meta if available
      if (inv.meta.projectId) {
        inv.projectId = inv.meta.projectId;
        inv.projectName = inv.meta.projectName || inv.projectName;
      }
    }

    res.json({ invoices: invoices });
  } catch (err) {
    console.error("Error fetching project sales invoices:", err);
    res.status(500).json({ message: "Database error" });
  }
};