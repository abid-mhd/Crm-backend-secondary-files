const db = require('../config/db');
const { validationResult } = require('express-validator');

const transactionController = {
  // Get all transactions for an employee
  async getEmployeeTransactions(req, res) {
  try {
    const { employeeId } = req.params;
    const { startDate, endDate, type } = req.query;

    console.log('Request received:', { employeeId, startDate, endDate, type });

    let query = `
      SELECT 
        t.*,
        e.employeeName,
        e.department,
        e.position
      FROM transactions t
      LEFT JOIN employees e ON t.employee_id = e.id
      WHERE t.employee_id = ?
    `;
    
    const queryParams = [parseInt(employeeId)];

    // Add filters
    if (startDate) {
      query += ' AND t.date >= ?';
      queryParams.push(startDate);
    }

    if (endDate) {
      query += ' AND t.date <= ?';
      queryParams.push(endDate);
    }

    if (type) {
      query += ' AND t.payment_type = ?';
      queryParams.push(type);
    }

    // Add sorting only (no pagination)
    query += ' ORDER BY t.date DESC, t.created_at DESC';

    console.log('Final Query:', query);
    console.log('Query Params:', queryParams);

    const [transactions] = await db.execute(query, queryParams);

    res.json({
      success: true,
      data: transactions,
      count: transactions.length
    });
  } catch (error) {
    console.error('Get employee transactions error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch transactions',
      error: error.message,
      sql: error.sql,
      params: error.params
    });
  }
},


  // Get single transaction by ID
  async getTransactionById(req, res) {
    try {
      const { id } = req.params;
      
      const query = `
        SELECT 
          t.*,
          e.employeeName,
          e.department,
          e.position
        FROM transactions t
        LEFT JOIN employees e ON t.employee_id = e.id
        WHERE t.id = ?
      `;
      
      console.log('Get transaction by ID query:', query, [parseInt(id)]);
      
      const [transactions] = await db.execute(query, [parseInt(id)]);
      
      if (transactions.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Transaction not found'
        });
      }
      
      res.json({
        success: true,
        data: transactions[0]
      });
    } catch (error) {
      console.error('Get transaction error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch transaction',
        error: error.message
      });
    }
  },

  // Create new transaction
  async createTransaction(req, res) {
    const conn = await db.getConnection();
    
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      await conn.beginTransaction();

      const {
        employee_id,
        payment_type,
        date,
        amount,
        payment_method = 'Cash',
        remarks = '',
        status = 'Completed'
      } = req.body;

      console.log('Creating transaction with data:', req.body);

      const query = `
        INSERT INTO transactions 
        (employee_id, payment_type, date, amount, payment_method, remarks, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      
      const params = [
        parseInt(employee_id),
        payment_type,
        date,
        parseFloat(amount),
        payment_method,
        remarks,
        status,
        req.user?.id || null
      ];

      console.log('Insert query:', query);
      console.log('Insert params:', params);

      const [result] = await conn.execute(query, params);
      const transactionId = result.insertId;

      // Get the newly created transaction with employee details
      const [newTransactions] = await conn.execute(
        `SELECT t.*, e.employeeName, e.department, e.position 
         FROM transactions t 
         LEFT JOIN employees e ON t.employee_id = e.id 
         WHERE t.id = ?`,
        [transactionId]
      );

      await conn.commit();

      res.status(201).json({
        success: true,
        message: 'Transaction created successfully',
        data: newTransactions[0]
      });
    } catch (error) {
      await conn.rollback();
      console.error('Create transaction error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to create transaction',
        error: error.message,
        sql: error.sql
      });
    } finally {
      conn.release();
    }
  },

  // Update transaction
  async updateTransaction(req, res) {
    const conn = await db.getConnection();
    
    try {
      const { id } = req.params;
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      await conn.beginTransaction();

      // Check if transaction exists
      const [existing] = await conn.execute(
        'SELECT * FROM transactions WHERE id = ?',
        [parseInt(id)]
      );

      if (existing.length === 0) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: 'Transaction not found'
        });
      }

      const allowedFields = ['payment_type', 'date', 'amount', 'payment_method', 'remarks', 'status'];
      const updateFields = [];
      const updateParams = [];

      // Build dynamic update query
      Object.keys(req.body).forEach(field => {
        if (allowedFields.includes(field)) {
          updateFields.push(`${field} = ?`);
          
          // Handle different data types
          if (field === 'amount') {
            updateParams.push(parseFloat(req.body[field]));
          } else {
            updateParams.push(req.body[field]);
          }
        }
      });

      if (updateFields.length === 0) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: 'No valid fields to update'
        });
      }

      updateParams.push(parseInt(id));

      const query = `
        UPDATE transactions 
        SET ${updateFields.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `;

      console.log('Update query:', query);
      console.log('Update params:', updateParams);

      const [result] = await conn.execute(query, updateParams);
      
      if (result.affectedRows === 0) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: 'Transaction not found'
        });
      }

      // Get updated transaction with employee details
      const [updatedTransactions] = await conn.execute(
        `SELECT t.*, e.employeeName, e.department, e.position 
         FROM transactions t 
         LEFT JOIN employees e ON t.employee_id = e.id 
         WHERE t.id = ?`,
        [parseInt(id)]
      );

      await conn.commit();

      res.json({
        success: true,
        message: 'Transaction updated successfully',
        data: updatedTransactions[0]
      });
    } catch (error) {
      await conn.rollback();
      console.error('Update transaction error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update transaction',
        error: error.message
      });
    } finally {
      conn.release();
    }
  },

  // Delete transaction
  async deleteTransaction(req, res) {
    const conn = await db.getConnection();
    
    try {
      const { id } = req.params;

      await conn.beginTransaction();

      // Check if transaction exists
      const [existing] = await conn.execute(
        'SELECT * FROM transactions WHERE id = ?',
        [parseInt(id)]
      );

      if (existing.length === 0) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: 'Transaction not found'
        });
      }

      const [result] = await conn.execute(
        'DELETE FROM transactions WHERE id = ?',
        [parseInt(id)]
      );

      if (result.affectedRows === 0) {
        await conn.rollback();
        return res.status(404).json({
          success: false,
          message: 'Transaction not found'
        });
      }

      await conn.commit();

      res.json({
        success: true,
        message: 'Transaction deleted successfully'
      });
    } catch (error) {
      await conn.rollback();
      console.error('Delete transaction error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to delete transaction',
        error: error.message
      });
    } finally {
      conn.release();
    }
  },

  // Get transaction summary for employee
  async getEmployeeTransactionSummary(req, res) {
    try {
      const { employeeId } = req.params;
      const { startDate, endDate } = req.query;
      
      let query = `
        SELECT 
          payment_type,
          COUNT(*) as transaction_count,
          SUM(amount) as total_amount,
          MIN(date) as first_transaction,
          MAX(date) as last_transaction
        FROM transactions 
        WHERE employee_id = ?
      `;
      
      const params = [parseInt(employeeId)];

      if (startDate) {
        query += ' AND date >= ?';
        params.push(startDate);
      }

      if (endDate) {
        query += ' AND date <= ?';
        params.push(endDate);
      }

      query += ' GROUP BY payment_type ORDER BY total_amount DESC';

      console.log('Summary query:', query);
      console.log('Summary params:', params);

      const [summary] = await db.execute(query, params);
      
      // Calculate overall totals
      const overallTotal = summary.reduce((total, item) => total + parseFloat(item.total_amount || 0), 0);
      const totalTransactions = summary.reduce((total, item) => total + (item.transaction_count || 0), 0);

      res.json({
        success: true,
        data: {
          byType: summary,
          overall: {
            totalTransactions,
            totalAmount: overallTotal
          }
        }
      });
    } catch (error) {
      console.error('Get transaction summary error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch transaction summary',
        error: error.message
      });
    }
  },

  // Simple test endpoint to check if transactions table exists
  async testTransactions(req, res) {
    try {
      // Simple query to check if table exists and get basic info
      const [tables] = await db.execute(
        "SHOW TABLES LIKE 'transactions'"
      );
      
      if (tables.length === 0) {
        return res.json({
          success: false,
          message: 'Transactions table does not exist'
        });
      }

      // Get table structure
      const [structure] = await db.execute(
        "DESCRIBE transactions"
      );

      // Get count of transactions
      const [[count]] = await db.execute(
        "SELECT COUNT(*) as total FROM transactions"
      );

      // Get sample data
      const [sample] = await db.execute(
        "SELECT * FROM transactions LIMIT 5"
      );

      res.json({
        success: true,
        tables: tables.length > 0,
        tableStructure: structure,
        totalTransactions: count.total,
        sampleData: sample
      });
    } catch (error) {
      console.error('Test transactions error:', error);
      res.status(500).json({
        success: false,
        message: 'Error testing transactions',
        error: error.message
      });
    }
  },

  // Get transactions with simple query (for debugging)
  async getEmployeeTransactionsSimple(req, res) {
    try {
      const { employeeId } = req.params;
      
      const query = `
        SELECT * FROM transactions 
        WHERE employee_id = ? 
        ORDER BY date DESC 
        LIMIT 10
      `;
      
      console.log('Simple query:', query, [parseInt(employeeId)]);
      
      const [transactions] = await db.execute(query, [parseInt(employeeId)]);

      res.json({
        success: true,
        data: transactions,
        count: transactions.length
      });
    } catch (error) {
      console.error('Simple transactions error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch transactions',
        error: error.message,
        sql: error.sql
      });
    }
  }
};

module.exports = transactionController;