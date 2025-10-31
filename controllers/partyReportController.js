// controllers/partyReportController.js
const db = require("../config/db");

// Get Receivable Ageing Report (Updated Query)
exports.getReceivableAgeingReport = async (req, res) => {
  try {
    const { ageingBucket } = req.query;
    
    let query = `
      SELECT 
        p.id,
        p.partyName,
        p.mobile,
        p.email,
        p.balance as outstandingAmount,
        DATEDIFF(CURDATE(), MAX(pt.transaction_date)) as daysOutstanding,
        CASE 
          WHEN DATEDIFF(CURDATE(), MAX(pt.transaction_date)) <= 30 THEN '0-30 Days'
          WHEN DATEDIFF(CURDATE(), MAX(pt.transaction_date)) <= 60 THEN '31-60 Days'
          WHEN DATEDIFF(CURDATE(), MAX(pt.transaction_date)) <= 90 THEN '61-90 Days'
          ELSE 'Over 90 Days'
        END as ageingBucket,
        MAX(pt.transaction_date) as lastTransactionDate,
        COUNT(pt.id) as totalInvoices
      FROM parties p
      LEFT JOIN parties_transactions pt ON p.id = pt.party_id
      WHERE p.balanceType = 'receivable' AND p.balance > 0
        AND pt.transaction_type IN ('SALE', 'CREDIT_NOTE')
        AND pt.debit_amount > 0
      GROUP BY p.id, p.partyName, p.mobile, p.email, p.balance
      HAVING 1=1
    `;
    
    const params = [];
    
    if (ageingBucket && ageingBucket !== 'all') {
      query += " AND ageingBucket = ?";
      params.push(ageingBucket);
    }
    
    query += " ORDER BY p.balance DESC";
    
    const [rows] = await db.execute(query, params);
    
    // Calculate summary
    const summary = {
      totalOutstanding: rows.reduce((sum, row) => sum + parseFloat(row.outstandingAmount), 0),
      totalCustomers: rows.length,
      byAgeing: rows.reduce((acc, row) => {
        acc[row.ageingBucket] = (acc[row.ageingBucket] || 0) + parseFloat(row.outstandingAmount);
        return acc;
      }, {})
    };
    
    res.json({
      success: true,
      data: rows,
      summary,
      totalRecords: rows.length
    });
  } catch (err) {
    console.error("Error fetching receivable ageing report:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching receivable ageing report", 
      error: err.message 
    });
  }
};

// Get Party Report By Item (Updated Query)
exports.getPartyReportByItem = async (req, res) => {
  try {
    const { partyId, itemId, startDate, endDate } = req.query;
    
    let query = `
      SELECT 
        p.partyName,
        pt.item_name as itemName,
        pt.item_id as itemCode,
        pt.transaction_date,
        pt.transaction_type,
        pt.invoice_number,
        pt.quantity,
        pt.rate,
        pt.amount,
        pt.discount,
        pt.tax_amount,
        (pt.quantity * pt.rate) as totalValue
      FROM parties p
      INNER JOIN parties_transactions pt ON p.id = pt.party_id
      WHERE pt.item_name IS NOT NULL AND pt.quantity > 0
    `;
    
    const params = [];
    
    if (partyId) {
      query += " AND p.id = ?";
      params.push(partyId);
    }
    
    if (itemId) {
      query += " AND pt.item_id = ?";
      params.push(itemId);
    }
    
    if (startDate && endDate) {
      query += " AND DATE(pt.transaction_date) BETWEEN ? AND ?";
      params.push(startDate, endDate);
    }
    
    query += " ORDER BY pt.transaction_date DESC, p.partyName, pt.item_name";
    
    const [rows] = await db.execute(query, params);
    
    // Group by party and item for summary
    const summary = rows.reduce((acc, row) => {
      const key = `${row.partyName}-${row.itemName}`;
      if (!acc[key]) {
        acc[key] = {
          partyName: row.partyName,
          itemName: row.itemName,
          itemCode: row.itemCode,
          totalQuantity: 0,
          totalAmount: 0,
          transactions: []
        };
      }
      
      acc[key].totalQuantity += parseFloat(row.quantity);
      acc[key].totalAmount += parseFloat(row.amount);
      acc[key].transactions.push({
        transactionDate: row.transaction_date,
        transactionType: row.transaction_type,
        invoiceNumber: row.invoice_number,
        quantity: row.quantity,
        rate: row.rate,
        amount: row.amount
      });
      
      return acc;
    }, {});
    
    res.json({
      success: true,
      data: rows,
      summary: Object.values(summary),
      totalRecords: rows.length
    });
  } catch (err) {
    console.error("Error fetching party report by item:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching party report by item", 
      error: err.message 
    });
  }
};

// Get Party Statement (Ledger) - Updated Query
exports.getPartyStatement = async (req, res) => {
  try {
    const { partyId, startDate, endDate } = req.query;
    
    let query = `
      SELECT 
        p.id,
        p.partyName,
        p.partyType,
        p.balance as currentBalance,
        p.balanceType,
        pt.transaction_date as transactionDate,
        pt.transaction_type as transactionType,
        pt.invoice_number as invoiceNumber,
        pt.ref_number as refNumber,
        pt.debit_amount as debit,
        pt.credit_amount as credit,
        pt.balance_amount as balanceAfterTransaction,
        pt.payment_mode as paymentMode,
        pt.status,
        pt.description
      FROM parties p
      LEFT JOIN parties_transactions pt ON p.id = pt.party_id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (partyId) {
      query += " AND p.id = ?";
      params.push(partyId);
    }
    
    if (startDate && endDate) {
      query += " AND DATE(pt.transaction_date) BETWEEN ? AND ?";
      params.push(startDate, endDate);
    }
    
    query += " ORDER BY pt.transaction_date DESC, p.partyName";
    
    const [rows] = await db.execute(query, params);
    
    // Calculate running balance
    let runningBalance = 0;
    const transactionsWithBalance = rows.map(transaction => {
      if (transaction.balanceType === 'receivable') {
        runningBalance += (transaction.debit - transaction.credit);
      } else {
        runningBalance += (transaction.credit - transaction.debit);
      }
      
      return {
        ...transaction,
        runningBalance: runningBalance
      };
    }).reverse(); // Reverse to show oldest first
    
    res.json({
      success: true,
      data: transactionsWithBalance,
      totalRecords: rows.length,
      openingBalance: rows.length > 0 ? runningBalance : 0,
      closingBalance: rows.reduce((sum, row) => sum + (row.debit - row.credit), 0)
    });
  } catch (err) {
    console.error("Error fetching party statement:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching party statement", 
      error: err.message 
    });
  }
};

// Get Party Wise Outstanding - Updated Query
exports.getPartyWiseOutstanding = async (req, res) => {
  try {
    const { partyType } = req.query;
    
    let query = `
      SELECT 
        p.id,
        p.partyName,
        p.partyType,
        p.mobile,
        p.email,
        p.balance as outstandingAmount,
        p.balanceType,
        COUNT(pt.id) as totalTransactions,
        MAX(pt.transaction_date) as lastTransactionDate,
        DATEDIFF(CURDATE(), MAX(pt.transaction_date)) as daysSinceLastTransaction,
        CASE 
          WHEN p.balanceType = 'receivable' THEN 'Customer'
          WHEN p.balanceType = 'payable' THEN 'Supplier'
          ELSE 'Other'
        END as partyCategory
      FROM parties p
      LEFT JOIN parties_transactions pt ON p.id = pt.party_id
      WHERE p.balance != 0
    `;
    
    const params = [];
    
    if (partyType && partyType !== 'all') {
      query += " AND p.partyType = ?";
      params.push(partyType);
    }
    
    query += " GROUP BY p.id, p.partyName, p.partyType, p.mobile, p.email, p.balance, p.balanceType";
    query += " ORDER BY p.balance DESC";
    
    const [rows] = await db.execute(query, params);
    
    const summary = {
      totalOutstanding: rows.reduce((sum, row) => sum + parseFloat(row.outstandingAmount), 0),
      totalParties: rows.length,
      receivableTotal: rows
        .filter(row => row.balanceType === 'receivable')
        .reduce((sum, row) => sum + parseFloat(row.outstandingAmount), 0),
      payableTotal: rows
        .filter(row => row.balanceType === 'payable')
        .reduce((sum, row) => sum + parseFloat(row.outstandingAmount), 0)
    };
    
    res.json({
      success: true,
      data: rows,
      summary,
      totalRecords: rows.length
    });
  } catch (err) {
    console.error("Error fetching party wise outstanding:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching party wise outstanding", 
      error: err.message 
    });
  }
};

// Get Sales Summary - Category Wise - Updated Query
exports.getSalesSummaryCategoryWise = async (req, res) => {
  try {
    const { startDate, endDate, category } = req.query;
    
    let query = `
      SELECT 
        p.partyName,
        p.category,
        pt.item_name as itemName,
        pt.category as itemCategory,
        COUNT(pt.id) as totalInvoices,
        SUM(pt.quantity) as totalQuantity,
        SUM(pt.amount) as totalAmount,
        AVG(pt.rate) as averageRate,
        MAX(pt.transaction_date) as lastSaleDate
      FROM parties p
      INNER JOIN parties_transactions pt ON p.id = pt.party_id
      WHERE pt.transaction_type = 'SALE'
        AND pt.amount > 0
    `;
    
    const params = [];
    
    if (startDate && endDate) {
      query += " AND DATE(pt.transaction_date) BETWEEN ? AND ?";
      params.push(startDate, endDate);
    }
    
    if (category && category !== 'all') {
      query += " AND p.category = ?";
      params.push(category);
    }
    
    query += " GROUP BY p.partyName, p.category, pt.item_name, pt.category";
    query += " ORDER BY totalAmount DESC";
    
    const [rows] = await db.execute(query, params);
    
    // Group by category for summary
    const categorySummary = rows.reduce((acc, row) => {
      if (!acc[row.category]) {
        acc[row.category] = {
          category: row.category,
          totalAmount: 0,
          totalQuantity: 0,
          totalInvoices: 0,
          parties: []
        };
      }
      
      acc[row.category].totalAmount += parseFloat(row.totalAmount);
      acc[row.category].totalQuantity += parseFloat(row.totalQuantity);
      acc[row.category].totalInvoices += parseInt(row.totalInvoices);
      
      // Add party if not exists
      if (!acc[row.category].parties.includes(row.partyName)) {
        acc[row.category].parties.push(row.partyName);
      }
      
      return acc;
    }, {});
    
    res.json({
      success: true,
      data: rows,
      categorySummary: Object.values(categorySummary),
      totalRecords: rows.length,
      grandTotal: rows.reduce((sum, row) => sum + parseFloat(row.totalAmount), 0)
    });
  } catch (err) {
    console.error("Error fetching sales summary category wise:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching sales summary category wise", 
      error: err.message 
    });
  }
};