// controllers/itemReportController.js
const db = require("../config/db");

// Get Stock Summary Report (Fixed)
exports.getStockSummary = async (req, res) => {
  try {
    const { category, lowStockOnly } = req.query;
    
    let query = `
      SELECT 
        i.id,
        i.name,
        i.code,
        i.category,
        i.measuringUnit,
        i.stock,
        COALESCE(i.minStockLevel, 0) as minStockLevel,
        i.purchasePrice,
        i.sellingPrice,
        (i.stock * COALESCE(i.purchasePrice, 0)) as stockValue,
        CASE 
          WHEN i.stock <= COALESCE(i.minStockLevel, 0) THEN 'Low Stock'
          WHEN i.stock = 0 THEN 'Out of Stock'
          ELSE 'In Stock'
        END as stockStatus,
        i.taxType,
        i.gstRate,
        i.hsnCode,
        i.asOfDate
      FROM items i
      WHERE 1=1
    `;
    
    const params = [];
    
    if (category && category !== 'all') {
      query += " AND i.category = ?";
      params.push(category);
    }
    
    if (lowStockOnly === 'true') {
      query += " AND i.stock <= COALESCE(i.minStockLevel, 0)";
    }
    
    query += " ORDER BY i.stock ASC, i.name ASC";
    
    const [rows] = await db.execute(query, params);
    
    const summary = {
      totalItems: rows.length,
      totalStockValue: rows.reduce((sum, row) => sum + parseFloat(row.stockValue || 0), 0),
      lowStockItems: rows.filter(row => row.stockStatus === 'Low Stock').length,
      outOfStockItems: rows.filter(row => row.stockStatus === 'Out of Stock').length,
      inStockItems: rows.filter(row => row.stockStatus === 'In Stock').length
    };
    
    res.json({
      success: true,
      data: rows,
      summary,
      totalRecords: rows.length
    });
  } catch (err) {
    console.error("Error fetching stock summary:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching stock summary", 
      error: err.message 
    });
  }
};

// Get Low Stock Alert Report (Fixed)
exports.getLowStockAlert = async (req, res) => {
  try {
    const { criticalOnly } = req.query;
    
    let query = `
      SELECT 
        i.id,
        i.name,
        i.code,
        i.category,
        i.measuringUnit,
        i.stock,
        COALESCE(i.minStockLevel, 10) as minStockLevel,
        (COALESCE(i.minStockLevel, 10) - i.stock) as shortageQuantity,
        i.purchasePrice,
        i.sellingPrice,
        ((COALESCE(i.minStockLevel, 10) - i.stock) * COALESCE(i.purchasePrice, 0)) as requiredInvestment,
        CASE 
          WHEN i.stock = 0 THEN 'Out of Stock'
          WHEN i.stock <= (COALESCE(i.minStockLevel, 10) * 0.2) THEN 'Critical'
          WHEN i.stock <= (COALESCE(i.minStockLevel, 10) * 0.5) THEN 'High Priority'
          ELSE 'Low Priority'
        END as priorityLevel,
        i.lastPurchaseDate,
        i.supplierId
      FROM items i
      WHERE i.stock <= COALESCE(i.minStockLevel, 10)
    `;
    
    const params = [];
    
    if (criticalOnly === 'true') {
      query += " AND i.stock <= (COALESCE(i.minStockLevel, 10) * 0.2)";
    }
    
    query += " ORDER BY i.stock ASC, priorityLevel DESC";
    
    const [rows] = await db.execute(query, params);
    
    const summary = {
      totalLowStockItems: rows.length,
      criticalItems: rows.filter(row => row.priorityLevel === 'Critical').length,
      highPriorityItems: rows.filter(row => row.priorityLevel === 'High Priority').length,
      totalRequiredInvestment: rows.reduce((sum, row) => sum + parseFloat(row.requiredInvestment || 0), 0),
      outOfStockItems: rows.filter(row => row.priorityLevel === 'Out of Stock').length
    };
    
    res.json({
      success: true,
      data: rows,
      summary,
      totalRecords: rows.length
    });
  } catch (err) {
    console.error("Error fetching low stock alert:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching low stock alert", 
      error: err.message 
    });
  }
};

// Get Item Wise Sales Report (Fixed)
exports.getItemWiseSales = async (req, res) => {
  try {
    const { itemId, startDate, endDate, category } = req.query;
    
    let query = `
      SELECT 
        i.name as itemName,
        i.code as itemCode,
        i.category,
        i.measuringUnit,
        COUNT(pt.id) as totalSales,
        SUM(COALESCE(pt.quantity, 0)) as totalQuantitySold,
        SUM(COALESCE(pt.amount, 0)) as totalSalesValue,
        AVG(COALESCE(pt.rate, 0)) as averageSellingPrice,
        MAX(pt.transaction_date) as lastSaleDate,
        MIN(pt.transaction_date) as firstSaleDate,
        (SUM(COALESCE(pt.amount, 0)) - (SUM(COALESCE(pt.quantity, 0)) * COALESCE(i.purchasePrice, 0))) as totalProfit,
        CASE 
          WHEN SUM(COALESCE(pt.quantity, 0)) > 0 
          THEN (SUM(COALESCE(pt.amount, 0)) / SUM(COALESCE(pt.quantity, 0)) - COALESCE(i.purchasePrice, 0))
          ELSE 0 
        END as profitPerUnit
      FROM items i
      LEFT JOIN parties_transactions pt ON i.name = pt.item_name AND pt.transaction_type = 'SALE'
      WHERE 1=1
    `;
    
    const params = [];
    
    if (itemId) {
      query += " AND i.id = ?";
      params.push(itemId);
    }
    
    if (startDate && endDate) {
      query += " AND DATE(pt.transaction_date) BETWEEN ? AND ?";
      params.push(startDate, endDate);
    }
    
    if (category && category !== 'all') {
      query += " AND i.category = ?";
      params.push(category);
    }
    
    query += " GROUP BY i.id, i.name, i.code, i.category, i.measuringUnit";
    query += " ORDER BY totalSalesValue DESC";
    
    const [rows] = await db.execute(query, params);
    
    const summary = {
      totalItems: rows.length,
      totalSalesValue: rows.reduce((sum, row) => sum + parseFloat(row.totalSalesValue || 0), 0),
      totalQuantitySold: rows.reduce((sum, row) => sum + parseFloat(row.totalQuantitySold || 0), 0),
      totalProfit: rows.reduce((sum, row) => sum + parseFloat(row.totalProfit || 0), 0)
    };
    
    res.json({
      success: true,
      data: rows,
      summary,
      totalRecords: rows.length
    });
  } catch (err) {
    console.error("Error fetching item wise sales:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching item wise sales", 
      error: err.message 
    });
  }
};

// Get Item Wise Purchase Report (Fixed)
exports.getItemWisePurchase = async (req, res) => {
  try {
    const { itemId, startDate, endDate, supplierId } = req.query;
    
    let query = `
      SELECT 
        i.name as itemName,
        i.code as itemCode,
        i.category,
        i.measuringUnit,
        p.partyName as supplierName,
        COUNT(pt.id) as totalPurchases,
        SUM(COALESCE(pt.quantity, 0)) as totalQuantityPurchased,
        SUM(COALESCE(pt.amount, 0)) as totalPurchaseValue,
        AVG(COALESCE(pt.rate, 0)) as averagePurchasePrice,
        MAX(pt.transaction_date) as lastPurchaseDate,
        MIN(pt.transaction_date) as firstPurchaseDate,
        SUM(COALESCE(pt.tax_amount, 0)) as totalTaxPaid
      FROM items i
      LEFT JOIN parties_transactions pt ON i.name = pt.item_name AND pt.transaction_type = 'PURCHASE'
      LEFT JOIN parties p ON pt.party_id = p.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (itemId) {
      query += " AND i.id = ?";
      params.push(itemId);
    }
    
    if (startDate && endDate) {
      query += " AND DATE(pt.transaction_date) BETWEEN ? AND ?";
      params.push(startDate, endDate);
    }
    
    if (supplierId) {
      query += " AND p.id = ?";
      params.push(supplierId);
    }
    
    query += " GROUP BY i.id, i.name, i.code, i.category, i.measuringUnit, p.partyName";
    query += " ORDER BY totalPurchaseValue DESC";
    
    const [rows] = await db.execute(query, params);
    
    const summary = {
      totalItems: rows.length,
      totalPurchaseValue: rows.reduce((sum, row) => sum + parseFloat(row.totalPurchaseValue || 0), 0),
      totalQuantityPurchased: rows.reduce((sum, row) => sum + parseFloat(row.totalQuantityPurchased || 0), 0),
      totalTaxPaid: rows.reduce((sum, row) => sum + parseFloat(row.totalTaxPaid || 0), 0)
    };
    
    res.json({
      success: true,
      data: rows,
      summary,
      totalRecords: rows.length
    });
  } catch (err) {
    console.error("Error fetching item wise purchase:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching item wise purchase", 
      error: err.message 
    });
  }
};

// Get Stock Valuation Report (Fixed)
exports.getStockValuation = async (req, res) => {
  try {
    const { valuationMethod, category } = req.query;
    
    let query = `
      SELECT 
        i.id,
        i.name as itemName,
        i.code as itemCode,
        i.category,
        i.measuringUnit,
        i.stock,
        COALESCE(i.purchasePrice, 0) as purchasePrice,
        COALESCE(i.sellingPrice, 0) as sellingPrice,
        (i.stock * COALESCE(i.purchasePrice, 0)) as fifoValue,
        (i.stock * COALESCE(i.sellingPrice, 0)) as marketValue,
        ((COALESCE(i.sellingPrice, 0) - COALESCE(i.purchasePrice, 0)) * i.stock) as potentialProfit,
        CASE 
          WHEN COALESCE(i.purchasePrice, 0) > 0 
          THEN ((COALESCE(i.sellingPrice, 0) - COALESCE(i.purchasePrice, 0)) / COALESCE(i.purchasePrice, 0) * 100)
          ELSE 0 
        END as profitMarginPercent,
        COALESCE(i.minStockLevel, 0) as minStockLevel,
        i.taxType,
        i.gstRate
      FROM items i
      WHERE i.stock > 0
    `;
    
    const params = [];
    
    if (category && category !== 'all') {
      query += " AND i.category = ?";
      params.push(category);
    }
    
    query += " ORDER BY fifoValue DESC";
    
    const [rows] = await db.execute(query, params);
    
    const summary = {
      totalItems: rows.length,
      totalStockQuantity: rows.reduce((sum, row) => sum + parseFloat(row.stock || 0), 0),
      fifoValuation: rows.reduce((sum, row) => sum + parseFloat(row.fifoValue || 0), 0),
      marketValuation: rows.reduce((sum, row) => sum + parseFloat(row.marketValue || 0), 0),
      totalPotentialProfit: rows.reduce((sum, row) => sum + parseFloat(row.potentialProfit || 0), 0),
      averageProfitMargin: rows.length > 0 ? 
        rows.reduce((sum, row) => sum + parseFloat(row.profitMarginPercent || 0), 0) / rows.length : 0
    };
    
    res.json({
      success: true,
      data: rows,
      summary,
      totalRecords: rows.length,
      valuationMethod: valuationMethod || 'FIFO'
    });
  } catch (err) {
    console.error("Error fetching stock valuation:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching stock valuation", 
      error: err.message 
    });
  }
};

// Get Item Movement Report (Fixed)
exports.getItemMovement = async (req, res) => {
  try {
    const { itemId, startDate, endDate, movementType } = req.query;
    
    let query = `
      SELECT 
        i.name as itemName,
        i.code as itemCode,
        pt.transaction_date,
        pt.transaction_type,
        pt.invoice_number,
        p.partyName,
        COALESCE(pt.quantity, 0) as quantity,
        COALESCE(pt.rate, 0) as rate,
        COALESCE(pt.amount, 0) as amount,
        pt.description,
        CASE 
          WHEN pt.transaction_type = 'SALE' THEN 'Outgoing'
          WHEN pt.transaction_type = 'PURCHASE' THEN 'Incoming'
          ELSE 'Adjustment'
        END as movementDirection,
        COALESCE(pt.balance_amount, 0) as stockAfterTransaction
      FROM items i
      LEFT JOIN parties_transactions pt ON i.name = pt.item_name
      LEFT JOIN parties p ON pt.party_id = p.id
      WHERE COALESCE(pt.quantity, 0) != 0
    `;
    
    const params = [];
    
    if (itemId) {
      query += " AND i.id = ?";
      params.push(itemId);
    }
    
    if (startDate && endDate) {
      query += " AND DATE(pt.transaction_date) BETWEEN ? AND ?";
      params.push(startDate, endDate);
    }
    
    if (movementType && movementType !== 'all') {
      if (movementType === 'incoming') {
        query += " AND pt.transaction_type = 'PURCHASE'";
      } else if (movementType === 'outgoing') {
        query += " AND pt.transaction_type = 'SALE'";
      }
    }
    
    query += " ORDER BY pt.transaction_date DESC, i.name ASC";
    
    const [rows] = await db.execute(query, params);
    
    const summary = {
      totalMovements: rows.length,
      incomingQuantity: rows
        .filter(row => row.movementDirection === 'Incoming')
        .reduce((sum, row) => sum + parseFloat(row.quantity || 0), 0),
      outgoingQuantity: rows
        .filter(row => row.movementDirection === 'Outgoing')
        .reduce((sum, row) => sum + parseFloat(row.quantity || 0), 0),
      netMovement: rows.reduce((sum, row) => {
        const quantity = parseFloat(row.quantity || 0);
        return row.movementDirection === 'Incoming' ? sum + quantity : sum - quantity;
      }, 0)
    };
    
    res.json({
      success: true,
      data: rows,
      summary,
      totalRecords: rows.length
    });
  } catch (err) {
    console.error("Error fetching item movement:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching item movement", 
      error: err.message 
    });
  }
};