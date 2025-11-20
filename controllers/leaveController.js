const db = require('../config/db');
const NotificationService = require('../services/notificationService');

// Get all leaves for current employee
const getMyLeaves = async (req, res) => {
  try {
    const userId = req.user.id; // From authenticated user
    
    // Get employee_id from users table
    const [users] = await db.query(
      'SELECT employee_id FROM users WHERE id = ?',
      [userId]
    );
    
    if (users.length === 0 || !users[0].employee_id) {
      return res.status(404).json({
        success: false,
        message: 'Employee profile not found. Please contact HR.'
      });
    }
    
    const employeeId = users[0].employee_id;
    
    const [leaves] = await db.query(`
      SELECT l.*, e.employeeName, e.position, e.department 
      FROM leaves l 
      LEFT JOIN employees e ON l.employee_id = e.id 
      WHERE l.employee_id = ? 
      ORDER BY l.created_at DESC
    `, [employeeId]);
    
    res.json({
      success: true,
      data: leaves
    });
  } catch (error) {
    console.error('Error fetching leaves:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch leaves'
    });
  }
};

// Get leave balance for current employee
const getMyLeaveBalance = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get employee_id from users table
    const [users] = await db.query(
      'SELECT employee_id FROM users WHERE id = ?',
      [userId]
    );
    
    if (users.length === 0 || !users[0].employee_id) {
      return res.status(404).json({
        success: false,
        message: 'Employee profile not found. Please contact HR.'
      });
    }
    
    const employeeId = users[0].employee_id;
    
    const [balance] = await db.query(
      'SELECT * FROM leave_balance WHERE employee_id = ?',
      [employeeId]
    );
    
    // if (balance.length === 0) {
    //   // Initialize leave balance if not exists
    //   const [newBalance] = await db.query(
    //     'INSERT INTO leave_balance (employee_id) VALUES (?)',
    //     [employeeId]
    //   );
      
    //   const [createdBalance] = await db.query(
    //     'SELECT * FROM leave_balance WHERE employee_id = ?',
    //     [employeeId]
    //   );
      
    //   return res.json({
    //     success: true,
    //     data: createdBalance[0]
    //   });
    // }
    
    res.json({
      success: true,
      data: balance[0]
    });
  } catch (error) {
    console.error('Error fetching leave balance:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch leave balance'
    });
  }
};

// Apply for leave
const applyLeave = async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const userId = req.user.id;
    const {
      leaveType,
      leaveReason,
      startDate,
      endDate,
      days
    } = req.body;
    
    // Get employee_id and details from users and employees tables
    const [users] = await connection.query(
      'SELECT employee_id FROM users WHERE id = ?',
      [userId]
    );
    
    if (users.length === 0 || !users[0].employee_id) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Employee profile not found. Please contact HR.'
      });
    }
    
    const employeeId = users[0].employee_id;
    
    // Get employee details
    const [employees] = await connection.query(
      'SELECT employeeName FROM employees WHERE id = ?',
      [employeeId]
    );
    
    if (employees.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Employee details not found'
      });
    }
    
    const employeeName = employees[0].employeeName;
    
    // Check if leave balance exists for the employee
    const [balance] = await connection.query(
      'SELECT * FROM leave_balance WHERE employee_id = ?',
      [employeeId]
    );
    
    const hasLeaveBalance = balance.length > 0 && 
      Object.keys(balance[0]).some(key => 
        key !== 'id' && 
        key !== 'employee_id' && 
        balance[0][key] !== null && 
        balance[0][key] !== 0 && 
        balance[0][key] !== '0'
      );
    
    let currentBalance = null;
    
    if (balance.length === 0) {
      // Initialize balance with NULL values for unlimited leaves
      await connection.query(
        'INSERT INTO leave_balance (employee_id, total_leave, casual_leave, sick_leave, permission) VALUES (?, NULL, NULL, NULL, NULL)',
        [employeeId]
      );
      
      const [newBalance] = await connection.query(
        'SELECT * FROM leave_balance WHERE employee_id = ?',
        [employeeId]
      );
      
      currentBalance = newBalance[0];
    } else {
      currentBalance = balance[0];
    }
    
    const daysRequested = parseFloat(days);
    
    // Validate leave balance only if employee has configured leave balance
    if (hasLeaveBalance) {
      const leaveTypeKey = leaveType.toLowerCase().replace(' ', '_');
      const availableBalance = currentBalance[leaveTypeKey];
      
      // Check if the specific leave type has balance configured
      const hasSpecificBalance = availableBalance !== null && availableBalance !== undefined && availableBalance !== '';
      
      if (hasSpecificBalance && availableBalance < daysRequested) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Insufficient ${leaveType} balance. Available: ${availableBalance} days`
        });
      }
    } else {
      // For unlimited leaves, apply reasonable limits
      const maxAllowedDays = 30; // Maximum days allowed per application for unlimited leaves
      
      if (daysRequested > maxAllowedDays) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `For flexible leave policy, maximum ${maxAllowedDays} days are allowed per application`
        });
      }
    }
    
    // Validate permission (only half day) - applies to both limited and unlimited leaves
    if (leaveType === 'Permission' && daysRequested !== 0.5) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Permission can only be applied for half day'
      });
    }
    
    // Validate dates
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);
      
      if (end < start) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: 'End date cannot be before start date'
        });
      }
    }
    
    // Calculate actual end date (for half day, end date should be same as start date)
    const actualEndDate = daysRequested === 0.5 ? startDate : (endDate || startDate);
    
    // Insert leave application
    const [result] = await connection.query(
      `INSERT INTO leaves 
      (employee_id, employee_name, leave_type, leave_reason, start_date, end_date, days, status) 
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Applied')`,
      [
        employeeId,
        employeeName,
        leaveType,
        leaveReason,
        startDate,
        actualEndDate,
        daysRequested
      ]
    );

    // Send notification to HR and Admin users
    const leaveData = {
      id: result.insertId,
      employeeName,
      leaveType,
      days: daysRequested,
      hasLeaveBalance: hasLeaveBalance
    };

    await NotificationService.createLeaveNotification(leaveData);
    
    await connection.commit();
    
    res.status(201).json({
      success: true,
      message: 'Leave application submitted successfully',
      data: {
        id: result.insertId,
        hasLeaveBalance: hasLeaveBalance
      }
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error applying leave:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to apply for leave'
    });
  } finally {
    connection.release();
  }
};

// Update leave application
const updateLeave = async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { id } = req.params;
    const userId = req.user.id;
    const {
      leaveType,
      leaveReason,
      startDate,
      endDate,
      days
    } = req.body;
    
    // Get employee_id from users table
    const [users] = await connection.query(
      'SELECT employee_id FROM users WHERE id = ?',
      [userId]
    );
    
    if (users.length === 0 || !users[0].employee_id) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Employee profile not found'
      });
    }
    
    const employeeId = users[0].employee_id;
    
    // Check if leave exists and belongs to employee
    const [leaves] = await connection.query(
      'SELECT * FROM leaves WHERE id = ? AND employee_id = ?',
      [id, employeeId]
    );
    
    if (leaves.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Leave application not found'
      });
    }
    
    const existingLeave = leaves[0];
    
    // Only allow editing if status is 'Applied'
    if (existingLeave.status !== 'Applied') {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Cannot edit leave that is already processed'
      });
    }
    
    // Update leave application
    await connection.query(
      `UPDATE leaves 
       SET leave_type = ?, leave_reason = ?, start_date = ?, end_date = ?, days = ?, updated_at = NOW()
       WHERE id = ? AND employee_id = ?`,
      [
        leaveType,
        leaveReason,
        startDate,
        endDate || startDate,
        parseFloat(days),
        id,
        employeeId
      ]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Leave application updated successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error updating leave:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update leave application'
    });
  } finally {
    connection.release();
  }
};

// Cancel/Delete leave application
const cancelLeave = async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { id } = req.params;
    const userId = req.user.id;
    
    // Get employee_id from users table
    const [users] = await connection.query(
      'SELECT employee_id FROM users WHERE id = ?',
      [userId]
    );
    
    if (users.length === 0 || !users[0].employee_id) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Employee profile not found. Please contact HR.'
      });
    }
    
    const employeeId = users[0].employee_id;
    
    // Check if leave exists and belongs to employee
    const [leaves] = await connection.query(
      'SELECT * FROM leaves WHERE id = ? AND employee_id = ?',
      [id, employeeId]
    );
    
    if (leaves.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Leave application not found'
      });
    }
    
    const leave = leaves[0];
    
    // Only allow cancellation if status is 'Applied'
    if (leave.status !== 'Applied') {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel leave that is already processed'
      });
    }
    
    // Delete leave application
    await connection.query(
      'DELETE FROM leaves WHERE id = ? AND employee_id = ?',
      [id, employeeId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Leave application cancelled successfully'
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error cancelling leave:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel leave application'
    });
  } finally {
    connection.release();
  }
};

// Admin: Get all leaves (for HR/Admin)
const getAllLeaves = async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT l.*, e.employeeName, e.position, e.department, e.employeeNo 
      FROM leaves l 
      LEFT JOIN employees e ON l.employee_id = e.id 
      WHERE 1=1
    `;
    let countQuery = `
      SELECT COUNT(*) as total 
      FROM leaves l 
      LEFT JOIN employees e ON l.employee_id = e.id 
      WHERE 1=1
    `;
    const params = [];
    
    if (status && status !== 'all') {
      query += ' AND l.status = ?';
      countQuery += ' AND l.status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    const [leaves] = await db.query(query, params);
    const [totalResult] = await db.query(countQuery, params.slice(0, -2));
    
    res.json({
      success: true,
      data: leaves,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalResult[0].total,
        pages: Math.ceil(totalResult[0].total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching all leaves:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch leaves'
    });
  }
};

// Admin: Update leave status
const updateLeaveStatus = async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { id } = req.params;
    const { status, comments } = req.body;
    const approvedBy = req.user.id; // Admin user ID
    
    // Check if leave exists
    const [leaves] = await connection.query(
      'SELECT * FROM leaves WHERE id = ?',
      [id]
    );
    
    if (leaves.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'Leave application not found'
      });
    }
    
    const leave = leaves[0];
    
    // Update leave status
    await connection.query(
      `UPDATE leaves 
       SET status = ?, approved_by = ?, approved_date = NOW(), comments = ?
       WHERE id = ?`,
      [status, approvedBy, comments, id]
    );
    
    // If approved, deduct from leave balance
    if (status === 'Approved') {
      const leaveTypeKey = leave.leave_type.toLowerCase().replace(' ', '_');
      
      await connection.query(
        `UPDATE leave_balance 
         SET ${leaveTypeKey} = ${leaveTypeKey} - ?, 
             total_leave = total_leave - ?,
             updated_at = NOW()
         WHERE employee_id = ?`,
        [leave.days, leave.days, leave.employee_id]
      );
    }
    
    // If rejected and was previously approved, restore balance
    if (status === 'Rejected' && leave.status === 'Approved') {
      const leaveTypeKey = leave.leave_type.toLowerCase().replace(' ', '_');
      
      await connection.query(
        `UPDATE leave_balance 
         SET ${leaveTypeKey} = ${leaveTypeKey} + ?, 
             total_leave = total_leave + ?,
             updated_at = NOW()
         WHERE employee_id = ?`,
        [leave.days, leave.days, leave.employee_id]
      );
    }

    // Send notification to the employee about leave status update
    await sendLeaveStatusNotification(leave, status, comments, approvedBy);
    
    await connection.commit();
    
    res.json({
      success: true,
      message: `Leave application ${status.toLowerCase()} successfully`
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error updating leave status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update leave status'
    });
  } finally {
    connection.release();
  }
};

// Helper function to send leave status notification to employee
const sendLeaveStatusNotification = async (leave, status, comments, approvedBy) => {
  try {
    // Get the user_id from employee_id
    const [users] = await db.query(
      'SELECT id FROM users WHERE employee_id = ?',
      [leave.employee_id]
    );
    
    if (users.length === 0) {
      console.log('User not found for employee:', leave.employee_id);
      return;
    }

    const employeeUserId = users[0].id;
    
    // Get admin user name who approved/rejected
    const [adminUsers] = await db.query(
      'SELECT name FROM users WHERE id = ?',
      [approvedBy]
    );
    
    const adminName = adminUsers.length > 0 ? adminUsers[0].name : 'Administrator';
    
    // Create notification message based on status and comments
    let title = '';
    let message = '';
    
    switch (status) {
      case 'Approved':
        title = 'Leave Application Approved';
        message = `Your ${leave.leave_type} leave application for ${leave.days} day(s) has been approved`;
        if (comments) {
          message += `. Comments: ${comments}`;
        }
        break;
        
      case 'Rejected':
        title = 'Leave Application Rejected';
        message = `Your ${leave.leave_type} leave application for ${leave.days} day(s) has been rejected`;
        if (comments) {
          message += `. Reason: ${comments}`;
        }
        break;
        
      case 'Pending':
        title = 'Leave Application Updated';
        message = `Your ${leave.leave_type} leave application status has been updated to pending`;
        if (comments) {
          message += `. Note: ${comments}`;
        }
        break;
        
      default:
        title = 'Leave Application Status Updated';
        message = `Your ${leave.leave_type} leave application status has been updated to ${status}`;
        if (comments) {
          message += `. Note: ${comments}`;
        }
    }
    
    // Add approved by information
    message += ` (by ${adminName})`;
    
    // Send notification to the employee
    await NotificationService.createNotification({
      userIds: [employeeUserId],
      title,
      message,
      type: 'leave_status_update',
      module: 'leaves',
      moduleId: leave.id
    });
    
    console.log(`Leave status notification sent to employee ${leave.employee_id}`);
    
  } catch (error) {
    console.error('Error sending leave status notification:', error);
    // Don't throw error here to avoid affecting the main transaction
  }
};

// Get leave statistics for dashboard
const getLeaveStatistics = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get employee_id from users table
    const [users] = await db.query(
      'SELECT employee_id FROM users WHERE id = ?',
      [userId]
    );
    
    if (users.length === 0 || !users[0].employee_id) {
      return res.status(404).json({
        success: false,
        message: 'Employee profile not found. Please contact HR.'
      });
    }
    
    const employeeId = users[0].employee_id;
    
    // Get current month and year
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1;
    const currentYear = currentDate.getFullYear();
    
    // Monthly leaves count
    const [monthlyLeaves] = await db.query(
      `SELECT COUNT(*) as count 
       FROM leaves 
       WHERE employee_id = ? 
       AND MONTH(start_date) = ? 
       AND YEAR(start_date) = ?`,
      [employeeId, currentMonth, currentYear]
    );
    
    // Leaves by status
    const [leavesByStatus] = await db.query(
      `SELECT status, COUNT(*) as count 
       FROM leaves 
       WHERE employee_id = ? 
       GROUP BY status`,
      [employeeId]
    );
    
    // Recent leaves
    const [recentLeaves] = await db.query(
      `SELECT * FROM leaves 
       WHERE employee_id = ? 
       ORDER BY created_at DESC 
       LIMIT 5`,
      [employeeId]
    );
    
    res.json({
      success: true,
      data: {
        monthlyLeaves: monthlyLeaves[0].count,
        leavesByStatus,
        recentLeaves
      }
    });
  } catch (error) {
    console.error('Error fetching leave statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch leave statistics'
    });
  }
};

const setLeaveBalanceForAll = async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { total_leave, casual_leave, sick_leave, permission } = req.body;
    
    // Validate input
    if (!total_leave || !casual_leave || !sick_leave || !permission) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: 'All leave balance fields are required'
      });
    }
    
    // Get all employee IDs
    const [employees] = await connection.query(
      'SELECT id FROM employees '
    );
    
    if (employees.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'No active employees found'
      });
    }
    
    // Update or insert leave balance for each employee
    for (const employee of employees) {
      const employeeId = employee.id;
      
      // Check if balance exists
      const [existingBalance] = await connection.query(
        'SELECT id FROM leave_balance WHERE employee_id = ?',
        [employeeId]
      );
      
      if (existingBalance.length > 0) {
        // Update existing balance
        await connection.query(
          'UPDATE leave_balance SET total_leave = ?, casual_leave = ?, sick_leave = ?, permission = ? WHERE employee_id = ?',
          [total_leave, casual_leave, sick_leave, permission, employeeId]
        );
      } else {
        // Insert new balance
        await connection.query(
          'INSERT INTO leave_balance (employee_id, total_leave, casual_leave, sick_leave, permission) VALUES (?, ?, ?, ?, ?)',
          [employeeId, total_leave, casual_leave, sick_leave, permission]
        );
      }
    }
    
    await connection.commit();
    
    res.status(200).json({
      success: true,
      message: `Leave balance set successfully for ${employees.length} employees`,
      data: {
        employeesUpdated: employees.length,
        balance: {
          total_leave,
          casual_leave,
          sick_leave,
          permission
        }
      }
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error setting leave balance:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to set leave balance'
    });
  } finally {
    connection.release();
  }
};

const getExistingLeaveBalance = async (req, res) => {
  try {
    // Get the first leave balance record to show current values
    const [balance] = await db.query(`
      SELECT 
        total_leave,
        casual_leave,
        sick_leave,
        permission
      FROM leave_balance 
      WHERE total_leave IS NOT NULL 
      OR casual_leave IS NOT NULL 
      OR sick_leave IS NOT NULL 
      OR permission IS NOT NULL
      LIMIT 1
    `);
    
    if (balance.length > 0) {
      res.json({
        success: true,
        data: balance[0]
      });
    } else {
      res.json({
        success: true,
        data: null,
        message: 'No existing leave balance found'
      });
    }
  } catch (error) {
    console.error('Error fetching existing leave balance:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch existing leave balance'
    });
  }
};

module.exports = {
  getMyLeaves,
  getMyLeaveBalance,
  applyLeave,
  updateLeave,
  cancelLeave,
  getAllLeaves,
  updateLeaveStatus,
  getLeaveStatistics,
  setLeaveBalanceForAll,
  getExistingLeaveBalance
};