const db = require("../config/db");

// Get all invoices with filters
exports.getAllInvoices = async (req, res) => {
  try {
    const { type, status, customer, startDate, endDate, search } = req.query;
    
    let query = `
      SELECT 
        i.id,
        i.invoiceNumber as invoiceNo,
        i.date,
        i.dueDate,
        i.status,
        i.subTotal,
        i.tax,
        i.discount,
        i.total as amount,
        i.type,
        i.meta,
        c.partyName as customer
      FROM invoices i
      LEFT JOIN parties c ON i.clientId = c.id
      WHERE 1=1
    `;
    
    const params = [];

    // Add filters
    if (type && type !== 'all') {
      query += ' AND i.type = ?';
      params.push(type);
    }

    if (status && status !== 'all') {
      query += ' AND i.status = ?';
      params.push(status);
    }

    if (customer && customer !== 'all') {
      query += ' AND c.partyName LIKE ?';
      params.push(`%${customer}%`);
    }

    if (search) {
      query += ' AND (i.invoiceNumber LIKE ? OR c.partyName LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (startDate && endDate) {
      query += ' AND i.date BETWEEN ? AND ?';
      params.push(startDate, endDate);
    }

    query += ' ORDER BY i.date DESC';

    console.log('Executing query:', query);
    console.log('With params:', params);

    const [rows] = await db.execute(query, params);
    
    res.json({
      success: true,
      data: rows,
      total: rows.length
    });
  } catch (err) {
    console.error("Error fetching invoices:", err);
    res.status(500).json({ 
      success: false, 
      error: "Failed to fetch invoices",
      details: err.message
    });
  }
};

// Get invoice statistics for cards and chart
exports.getInvoiceStats = async (req, res) => {
  try {
    const { period = 'weekly', type = 'all' } = req.query;

    // Base query for counts
    let countQuery = `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN type = 'sales' THEN 1 ELSE 0 END) as salesCount,
        SUM(CASE WHEN type = 'purchase' THEN 1 ELSE 0 END) as purchaseCount,
        SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paidCount,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pendingCount,
        SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) as overdueCount,
        SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as draftCount
      FROM invoices 
      WHERE 1=1
    `;

    const countParams = [];

    if (type && type !== 'all') {
      countQuery += ' AND type = ?';
      countParams.push(type);
    }

    const [countResult] = await db.execute(countQuery, countParams);

    // Chart data based on period
    let chartQuery = '';
    let categories = [];
    const chartParams = [];

    if (period === 'weekly') {
      // Last 7 days
      chartQuery = `
        SELECT 
          DATE(date) as day,
          type,
          COUNT(*) as count
        FROM invoices 
        WHERE date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
        ${type && type !== 'all' ? 'AND type = ?' : ''}
        GROUP BY DATE(date), type
        ORDER BY day ASC
      `;
      
      if (type && type !== 'all') {
        chartParams.push(type);
      }
      
      // Generate last 7 days as categories
      for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        categories.push(date.toLocaleDateString('en-US', { weekday: 'short' }));
      }
    } else if (period === 'monthly') {
      // Last 30 days grouped by week
      chartQuery = `
        SELECT 
          YEARWEEK(date) as week,
          type,
          COUNT(*) as count
        FROM invoices 
        WHERE date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        ${type && type !== 'all' ? 'AND type = ?' : ''}
        GROUP BY YEARWEEK(date), type
        ORDER BY week ASC
      `;
      
      if (type && type !== 'all') {
        chartParams.push(type);
      }
      
      // Generate last 5 weeks as categories
      for (let i = 4; i >= 0; i--) {
        categories.push(`Week ${5 - i}`);
      }
    } else if (period === 'yearly') {
      // Last 12 months
      chartQuery = `
        SELECT 
          DATE_FORMAT(date, '%Y-%m') as month,
          type,
          COUNT(*) as count
        FROM invoices 
        WHERE date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
        ${type && type !== 'all' ? 'AND type = ?' : ''}
        GROUP BY DATE_FORMAT(date, '%Y-%m'), type
        ORDER BY month ASC
      `;
      
      if (type && type !== 'all') {
        chartParams.push(type);
      }
      
      // Generate last 12 months as categories
      for (let i = 11; i >= 0; i--) {
        const date = new Date();
        date.setMonth(date.getMonth() - i);
        categories.push(date.toLocaleDateString('en-US', { month: 'short' }));
      }
    }

    const [chartResult] = await db.execute(chartQuery, chartParams);

    // Process chart data
    const salesData = new Array(categories.length).fill(0);
    const purchaseData = new Array(categories.length).fill(0);

    if (period === 'weekly') {
      chartResult.forEach(row => {
        const date = new Date(row.day);
        const today = new Date();
        const diffDays = Math.floor((today - date) / (1000 * 60 * 60 * 24));
        const index = 6 - diffDays;
        
        if (index >= 0 && index < categories.length) {
          if (row.type === 'sales') {
            salesData[index] += row.count;
          } else if (row.type === 'purchase') {
            purchaseData[index] += row.count;
          }
        }
      });
    } else if (period === 'monthly') {
      // For monthly, we need to map weeks to our 5-week categories
      const weeks = [...new Set(chartResult.map(row => row.week))].sort();
      weeks.forEach((week, weekIndex) => {
        if (weekIndex < categories.length) {
          const weekData = chartResult.filter(row => row.week === week);
          weekData.forEach(row => {
            if (row.type === 'sales') {
              salesData[weekIndex] += row.count;
            } else if (row.type === 'purchase') {
              purchaseData[weekIndex] += row.count;
            }
          });
        }
      });
    } else if (period === 'yearly') {
      chartResult.forEach((row, index) => {
        if (index < categories.length) {
          if (row.type === 'sales') {
            salesData[index] = row.count;
          } else if (row.type === 'purchase') {
            purchaseData[index] = row.count;
          }
        }
      });
    }

    res.json({
      success: true,
      data: {
        counts: countResult[0],
        chart: {
          categories,
          series: [
            { name: "Sales Invoices", data: salesData },
            { name: "Purchase Invoices", data: purchaseData }
          ]
        }
      }
    });
  } catch (err) {
    console.error("Error fetching invoice stats:", err);
    res.status(500).json({ 
      success: false, 
      error: "Failed to fetch invoice statistics",
      details: err.message
    });
  }
};

// Get unique filter values
exports.getFilterOptions = async (req, res) => {
  try {
    const [statuses] = await db.execute('SELECT DISTINCT status FROM invoices WHERE status IS NOT NULL');
    const [types] = await db.execute('SELECT DISTINCT type FROM invoices WHERE type IS NOT NULL');
    const [customers] = await db.execute(`
      SELECT DISTINCT p.partyName 
      FROM parties p 
      INNER JOIN invoices i ON p.id = i.clientId
      WHERE p.partyName IS NOT NULL
    `);

    res.json({
      success: true,
      data: {
        statuses: statuses.map(s => s.status),
        types: types.map(t => t.type),
        customers: customers.map(c => c.partyName)
      }
    });
  } catch (err) {
    console.error("Error fetching filter options:", err);
    res.status(500).json({ 
      success: false, 
      error: "Failed to fetch filter options",
      details: err.message
    });
  }
};