const db = require('../config/db');
const NotificationService = require('../services/notificationService');

// Get all leaves for current employee (including leave_approval requests)
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
    
    // Query for regular leaves and leave_approval requests
    const [leaves] = await db.query(`
      SELECT 
        l.id,
        l.employee_id,
        e.employeeName,
        e.position,
        e.department,
        l.leave_type,
        e.employeeName as employee_name,
        l.leave_reason,
        l.start_date,
        l.end_date,
        l.days,
        l.status,
        l.approved_by,
        l.approved_date,
        l.created_at,
        l.updated_at,
        l.applied_date,
        'leave' as source_type,
        NULL as request_id,
        NULL as admin_remarks
      FROM leaves l 
      LEFT JOIN employees e ON l.employee_id = e.id 
      WHERE l.employee_id = ? 
      
      UNION ALL
      
      SELECT 
        NULL as id,
        er.employee_id,
        e.employeeName,
        e.position,
        e.department,
        'Leave Approval Request' as leave_type,
        e.employeeName as employee_name,
        er.reason as leave_reason,
        er.request_date as start_date,
        er.request_date as end_date,
        1 as days,
        er.status,
        NULL as approved_by,
        NULL as approved_date,
        er.created_at,
        er.updated_at,
        er.created_at as applied_date,
        'employee_request' as source_type,
        er.id as request_id,
        er.admin_remarks
      FROM employee_requests er
      LEFT JOIN employees e ON er.employee_id = e.id 
      WHERE er.employee_id = ? 
      AND er.request_type = 'leave_approval'
      
      ORDER BY created_at DESC
    `, [employeeId, employeeId]);
    
    // Process the combined results
    const processedLeaves = leaves.map(leave => {
      const result = {
        id: leave.source_type === 'leave' ? leave.id : `request_${leave.request_id}`,
        employee_id: leave.employee_id,
        employeeName: leave.employeeName,
        position: leave.position,
        department: leave.department,
        leave_type: leave.leave_type,
        employee_name: leave.employee_name,
        leave_reason: leave.leave_reason,
        start_date: leave.start_date,
        end_date: leave.end_date,
        days: leave.days,
        status: leave.status,
        approved_by: leave.approved_by,
        approved_date: leave.approved_date,
        created_at: leave.created_at,
        updated_at: leave.updated_at,
        applied_date: leave.applied_date,
        is_leave_request: leave.source_type === 'employee_request',
        request_id: leave.request_id,
        admin_remarks: leave.admin_remarks
      };
      
      return result;
    });
    
    res.json({
      success: true,
      data: processedLeaves
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
    
    // Validate leave type
    const validLeaveTypes = ['Casual Leave', 'Sick Leave', 'Permission', 'Women Special'];
    if (!validLeaveTypes.includes(leaveType)) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: `Invalid leave type. Allowed types: ${validLeaveTypes.join(', ')}`
      });
    }
    
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
        'INSERT INTO leave_balance (employee_id, total_leave, casual_leave, sick_leave, permission, women_special) VALUES (?, NULL, NULL, NULL, NULL, NULL)',
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
      const leaveTypeMap = {
        'Casual Leave': 'casual_leave',
        'Sick Leave': 'sick_leave',
        'Permission': 'permission',
        'Women Special': 'women_special',
        'Woman Special': 'women_special', // Add this for consistency
        'Women Special': 'women_special' // Add this for consistency
      };
      
      const leaveTypeKey = leaveTypeMap[leaveType];
      const availableBalance = currentBalance[leaveTypeKey];
      
      // Check if the specific leave type has balance configured (not NULL)
      const hasSpecificBalance = availableBalance !== null && availableBalance !== undefined && availableBalance !== '';
      
      if (hasSpecificBalance && availableBalance < daysRequested) {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: `Insufficient ${leaveType} balance. Available: ${availableBalance} days`
        });
      }
    } else {
      // For unlimited leaves (NULL values), apply reasonable limits
      const maxAllowedDays = 30;
      
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
    
    if (error.code === 'WARN_DATA_TRUNCATED' && error.sqlMessage.includes('leave_type')) {
      return res.status(400).json({
        success: false,
        message: 'Invalid leave type. Please contact administrator to update available leave types.'
      });
    }
    
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
    
    // Check if it's a regular leave or leave_approval request
    if (id.startsWith('request_')) {
      const requestId = id.replace('request_', '');
      
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
      
      // Check if leave_approval request exists and belongs to employee
      const [requests] = await connection.query(
        'SELECT * FROM employee_requests WHERE id = ? AND employee_id = ? AND request_type = ?',
        [requestId, employeeId, 'leave_approval']
      );
      
      if (requests.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: 'Leave request not found'
        });
      }
      
      const existingRequest = requests[0];
      
      // Only allow editing if status is 'pending'
      if (existingRequest.status !== 'pending') {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: 'Cannot edit leave request that is already processed'
        });
      }
      
      // Update leave_approval request
      await connection.query(
        `UPDATE employee_requests 
         SET request_date = ?, reason = ?, updated_at = NOW()
         WHERE id = ? AND employee_id = ? AND request_type = ?`,
        [startDate, leaveReason, requestId, employeeId, 'leave_approval']
      );
      
    } else {
      // Regular leave update logic (existing code)
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
    }
    
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
    
    // Check if it's a regular leave or leave_approval request
    if (id.startsWith('request_')) {
      const requestId = id.replace('request_', '');
      
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
      
      // Check if leave_approval request exists and belongs to employee
      const [requests] = await connection.query(
        'SELECT * FROM employee_requests WHERE id = ? AND employee_id = ? AND request_type = ?',
        [requestId, employeeId, 'leave_approval']
      );
      
      if (requests.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: 'Leave request not found'
        });
      }
      
      const request = requests[0];
      
      // Only allow cancellation if status is 'pending'
      if (request.status !== 'pending') {
        await connection.rollback();
        return res.status(400).json({
          success: false,
          message: 'Cannot cancel leave request that is already processed'
        });
      }
      
      // Delete leave_approval request
      await connection.query(
        'DELETE FROM employee_requests WHERE id = ? AND employee_id = ? AND request_type = ?',
        [requestId, employeeId, 'leave_approval']
      );
      
    } else {
      // Regular leave cancellation logic (existing code)
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
    }
    
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

// Admin: Get all leaves (for HR/Admin) - including leave_approval requests
const getAllLeaves = async (req, res) => {
  try {
    const { status, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    
    // Build WHERE clause for both leaves and employee_requests
    let whereClause = 'WHERE 1=1';
    const params = [];
    
    if (status && status !== 'all') {
      whereClause += ' AND status = ?';
      params.push(status);
    }
    
    // Query for regular leaves - selecting specific columns to match second query
    let leavesQuery = `
      SELECT 
        l.id,
        l.employee_id,
        e.employeeName,
        e.position,
        e.department,
        e.employeeNo,
        l.leave_type,
        l.employee_name,
        l.leave_reason,
        l.start_date,
        l.end_date,
        l.days,
        l.status,
        l.approved_by,
        l.approved_date,
        l.created_at,
        l.updated_at,
        l.comments,
        l.applied_date,
        'leave' as source_type,
        NULL as request_id,
        NULL as admin_remarks
      FROM leaves l 
      LEFT JOIN employees e ON l.employee_id = e.id 
      ${whereClause}
    `;
    
    // Query for leave_approval requests - must match exact same columns
    let requestsQuery = `
      SELECT 
        NULL as id,
        er.employee_id,
        e.employeeName,
        e.position,
        e.department,
        e.employeeNo,
        'Leave Approval Request' as leave_type,
        e.employeeName as employee_name,
        er.reason as leave_reason,
        er.request_date as start_date,
        er.request_date as end_date,
        1 as days,
        er.status,
        NULL as approved_by,
        NULL as approved_date,
        er.created_at,
        er.updated_at,
        er.admin_remarks as comments,
        er.created_at as applied_date,
        'employee_request' as source_type,
        er.id as request_id,
        er.admin_remarks
      FROM employee_requests er
      LEFT JOIN employees e ON er.employee_id = e.id 
      WHERE er.request_type = 'leave_approval'
    `;
    
    // Add status filter for requests if applicable
    if (status && status !== 'all') {
      requestsQuery += ' AND er.status = ?';
      // Note: We'll handle parameters separately
    }
    
    // Combine both queries
    const combinedQuery = `
      (${leavesQuery}) 
      UNION ALL 
      (${requestsQuery})
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `;
    
    // For count query
    const countQuery = `
      SELECT (
        (SELECT COUNT(*) FROM leaves l WHERE 1=1 ${status && status !== 'all' ? 'AND l.status = ?' : ''}) +
        (SELECT COUNT(*) FROM employee_requests er 
         WHERE er.request_type = 'leave_approval' 
         ${status && status !== 'all' ? 'AND er.status = ?' : ''})
      ) as total
    `;
    
    // Prepare parameters for the combined query
    const queryParams = [...params];
    if (status && status !== 'all') {
      // Add status parameter for requests query as well
      queryParams.push(status);
    }
    queryParams.push(parseInt(limit), parseInt(offset));
    
    // Prepare parameters for count query
    const countParams = [];
    if (status && status !== 'all') {
      countParams.push(status, status);
    }
    
    // Execute queries
    const [leaves] = await db.query(combinedQuery, queryParams);
    const [totalResult] = await db.query(countQuery, countParams);
    
    // Process the results to add metadata
    const processedLeaves = leaves.map(leave => {
      const result = {
        id: leave.source_type === 'leave' ? leave.id : `request_${leave.request_id}`,
        employee_id: leave.employee_id,
        employeeName: leave.employeeName,
        position: leave.position,
        department: leave.department,
        employeeNo: leave.employeeNo,
        leave_type: leave.leave_type,
        employee_name: leave.employee_name,
        leave_reason: leave.leave_reason,
        start_date: leave.start_date,
        end_date: leave.end_date,
        days: leave.days,
        status: leave.status,
        approved_by: leave.approved_by,
        approved_date: leave.approved_date,
        created_at: leave.created_at,
        updated_at: leave.updated_at,
        comments: leave.comments,
        applied_date: leave.applied_date,
        is_leave_request: leave.source_type === 'employee_request',
        request_id: leave.request_id,
        admin_remarks: leave.admin_remarks
      };
      
      return result;
    });
    
    res.json({
      success: true,
      data: processedLeaves,
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

// Admin: Update leave status (handles both regular leaves and leave_approval requests)
const updateLeaveStatus = async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { id } = req.params;
    const { status, comments } = req.body;
    const approvedBy = req.user.id;
    
    // Check if it's a regular leave or leave_approval request
    if (id.startsWith('request_')) {
      const requestId = id.replace('request_', '');
      
      // Check if leave_approval request exists
      const [requests] = await connection.query(
        `SELECT er.*, e.employeeName 
         FROM employee_requests er 
         LEFT JOIN employees e ON er.employee_id = e.id 
         WHERE er.id = ? AND er.request_type = 'leave_approval'`,
        [requestId]
      );
      
      if (requests.length === 0) {
        await connection.rollback();
        return res.status(404).json({
          success: false,
          message: 'Leave approval request not found'
        });
      }
      
      const request = requests[0];
      
      // Update leave_approval request status
      await connection.query(
        `UPDATE employee_requests 
         SET status = ?, admin_remarks = ?, handled_by = ?, handled_at = NOW(), updated_at = NOW()
         WHERE id = ?`,
        [status, comments, approvedBy, requestId]
      );
      
      // If approved, also create a corresponding leave record
      if (status === 'approved') {
        const leaveType = 'Leave Approval'; // You can customize this or make it configurable
        
        // Insert leave record
        const [leaveResult] = await connection.query(
          `INSERT INTO leaves 
          (employee_id, employee_name, leave_type, leave_reason, start_date, end_date, days, status, approved_by, approved_date, comments) 
          VALUES (?, ?, ?, ?, ?, ?, 1, 'Approved', ?, NOW(), ?)`,
          [
            request.employee_id,
            request.employeeName,
            leaveType,
            request.reason,
            request.request_date,
            request.request_date,
            approvedBy,
            comments || 'Approved via leave approval request'
          ]
        );
        
        // Also update attendance records
        const requestDate = new Date(request.request_date);
        const year = requestDate.getFullYear();
        const month = String(requestDate.getMonth() + 1).padStart(2, '0');
        const day = String(requestDate.getDate()).padStart(2, '0');
        const formattedDate = `${year}-${month}-${day}`;
        
        // Check if attendance record exists
        const [existingAttendance] = await connection.query(
          'SELECT id FROM attendance WHERE employee_id = ? AND date = ?',
          [request.employee_id, formattedDate]
        );
        
        if (existingAttendance.length > 0) {
          // Update existing attendance
          await connection.query(
            `UPDATE attendance 
             SET status = 'Leave', 
                 remarks = CONCAT(COALESCE(remarks, ''), ' | Leave Approved: ${leaveType}'),
                 updated_at = NOW()
             WHERE employee_id = ? AND date = ?`,
            [request.employee_id, formattedDate]
          );
        } else {
          // Create new attendance record
          await connection.query(
            `INSERT INTO attendance 
             (employee_id, date, status, remarks, created_at, updated_at) 
             VALUES (?, ?, 'Leave', 'Leave Approved: ${leaveType}', NOW(), NOW())`,
            [request.employee_id, formattedDate]
          );
        }
      }
      
    } else {
      // Regular leave status update (existing code)
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
      
      // Use dates directly without timezone conversion
      const startDate = new Date(leave.start_date);
      const endDate = new Date(leave.end_date);
      
      // Extract date parts to avoid timezone issues
      const localStartDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
      const localEndDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
      
      // Update leave status
      await connection.query(
        `UPDATE leaves 
         SET status = ?, approved_by = ?, approved_date = NOW(), comments = ?
         WHERE id = ?`,
        [status, approvedBy, comments, id]
      );
      
      // If approved, deduct from leave balance AND update attendance records
      if (status === 'Approved') {
        // Map leave type to database column name
        const leaveTypeMap = {
          'Casual Leave': 'casual_leave',
          'Sick Leave': 'sick_leave',
          'Permission': 'permission',
          'Women Special': 'women_special',
          'Woman Special': 'women_special',
          'Women Special': 'women_special'
        };
        
        const leaveTypeKey = leaveTypeMap[leave.leave_type];
        
        if (!leaveTypeKey) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `Invalid leave type: ${leave.leave_type}. Valid types are: ${Object.keys(leaveTypeMap).join(', ')}`
          });
        }
        
        // Check if the employee has a leave balance record
        const [balanceCheck] = await connection.query(
          'SELECT * FROM leave_balance WHERE employee_id = ?',
          [leave.employee_id]
        );
        
        if (balanceCheck.length > 0) {
          const currentBalance = balanceCheck[0];
          
          // Only deduct if the specific leave type has a configured balance (not NULL)
          if (currentBalance[leaveTypeKey] !== null && currentBalance[leaveTypeKey] !== undefined) {
            await connection.query(
              `UPDATE leave_balance 
               SET ${leaveTypeKey} = ${leaveTypeKey} - ?, 
                   total_leave = total_leave - ?,
                   updated_at = NOW()
               WHERE employee_id = ?`,
              [leave.days, leave.days, leave.employee_id]
            );
          }
        }

        // Update attendance records
        let currentDate = new Date(localStartDate);
        const finalEndDate = new Date(localEndDate);
        
        while (currentDate <= finalEndDate) {
          // Format date as YYYY-MM-DD
          const year = currentDate.getFullYear();
          const month = String(currentDate.getMonth() + 1).padStart(2, '0');
          const day = String(currentDate.getDate()).padStart(2, '0');
          const formattedDate = `${year}-${month}-${day}`;
          
          // Check if attendance record already exists
          const [existingAttendance] = await connection.query(
            'SELECT id, status, remarks FROM attendance WHERE employee_id = ? AND date = ?',
            [leave.employee_id, formattedDate]
          );
          
          if (existingAttendance.length > 0) {
            // Update existing attendance record
            const existingRecord = existingAttendance[0];
            const newRemarks = existingRecord.remarks 
              ? `${existingRecord.remarks} | Leave Approved: ${leave.leave_type}`
              : `Leave Approved: ${leave.leave_type}`;
            
            await connection.query(
              `UPDATE attendance 
               SET status = 'Leave', 
                   remarks = ?,
                   updated_at = NOW()
               WHERE employee_id = ? AND date = ?`,
              [newRemarks, leave.employee_id, formattedDate]
            );
          } else {
            // Insert new attendance record
            await connection.query(
              `INSERT INTO attendance 
               (employee_id, date, status, remarks, created_at, updated_at) 
               VALUES (?, ?, 'Leave', 'Leave Approved: ${leave.leave_type}', NOW(), NOW())`,
              [leave.employee_id, formattedDate]
            );
          }
          
          currentDate.setDate(currentDate.getDate() + 1);
        }
      }
      
      // If rejected and was previously approved, restore balance
      if (status === 'Rejected' && leave.status === 'Approved') {
        // Map leave type to database column name
        const leaveTypeMap = {
          'Casual Leave': 'casual_leave',
          'Sick Leave': 'sick_leave',
          'Permission': 'permission',
          'Women Special': 'women_special',
          'Woman Special': 'women_special',
          'Women Special': 'women_special'
        };
        
        const leaveTypeKey = leaveTypeMap[leave.leave_type];
        
        if (!leaveTypeKey) {
          await connection.rollback();
          return res.status(400).json({
            success: false,
            message: `Invalid leave type: ${leave.leave_type}. Valid types are: ${Object.keys(leaveTypeMap).join(', ')}`
          });
        }
        
        // Check if the employee has a leave balance record
        const [balanceCheck] = await connection.query(
          'SELECT * FROM leave_balance WHERE employee_id = ?',
          [leave.employee_id]
        );
        
        if (balanceCheck.length > 0) {
          const currentBalance = balanceCheck[0];
          
          // Only restore if the specific leave type has a configured balance (not NULL)
          if (currentBalance[leaveTypeKey] !== null && currentBalance[leaveTypeKey] !== undefined) {
            await connection.query(
              `UPDATE leave_balance 
               SET ${leaveTypeKey} = ${leaveTypeKey} + ?, 
                   total_leave = total_leave + ?,
                   updated_at = NOW()
               WHERE employee_id = ?`,
              [leave.days, leave.days, leave.employee_id]
            );
          }
        }

        // Remove Leave attendance records
        let currentDate = new Date(localStartDate);
        const finalEndDate = new Date(localEndDate);
        
        while (currentDate <= finalEndDate) {
          // Format date as YYYY-MM-DD
          const year = currentDate.getFullYear();
          const month = String(currentDate.getMonth() + 1).padStart(2, '0');
          const day = String(currentDate.getDate()).padStart(2, '0');
          const formattedDate = `${year}-${month}-${day}`;
          
          // Check if attendance record exists and was marked as Leave for this leave
          const [existingAttendance] = await connection.query(
            `SELECT id FROM attendance 
             WHERE employee_id = ? AND date = ? AND status = 'Leave' 
             AND remarks LIKE ?`,
            [leave.employee_id, formattedDate, `%Leave Approved: ${leave.leave_type}%`]
          );
          
          if (existingAttendance.length > 0) {
            // Delete the attendance record
            await connection.query(
              'DELETE FROM attendance WHERE employee_id = ? AND date = ? AND status = "Leave" AND remarks LIKE ?',
              [leave.employee_id, formattedDate, `%Leave Approved: ${leave.leave_type}%`]
            );
          }
          
          currentDate.setDate(currentDate.getDate() + 1);
        }
      }

      // Send notification to the employee about leave status update
      await sendLeaveStatusNotification(leave, status, comments, approvedBy);
    }
    
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
      message: 'Failed to update leave status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
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
      case 'approved':
        title = 'Leave Application Approved';
        message = `Your ${leave.leave_type} leave application for ${leave.days || 1} day(s) has been approved`;
        if (comments) {
          message += `. Comments: ${comments}`;
        }
        break;
        
      case 'Rejected':
      case 'rejected':
        title = 'Leave Application Rejected';
        message = `Your ${leave.leave_type} leave application for ${leave.days || 1} day(s) has been rejected`;
        if (comments) {
          message += `. Reason: ${comments}`;
        }
        break;
        
      case 'Pending':
      case 'pending':
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
    
    // Monthly leaves count (including leave_approval requests)
    const [monthlyLeaves] = await db.query(
      `SELECT COUNT(*) as count 
       FROM (
         SELECT start_date FROM leaves WHERE employee_id = ? 
         UNION ALL
         SELECT request_date FROM employee_requests 
         WHERE employee_id = ? AND request_type = 'leave_approval'
       ) as all_leaves
       WHERE MONTH(start_date) = ? AND YEAR(start_date) = ?`,
      [employeeId, employeeId, currentMonth, currentYear]
    );
    
    // Leaves by status (including leave_approval requests)
    const [leavesByStatus] = await db.query(
      `SELECT status, COUNT(*) as count 
       FROM (
         SELECT status FROM leaves WHERE employee_id = ? 
         UNION ALL
         SELECT status FROM employee_requests 
         WHERE employee_id = ? AND request_type = 'leave_approval'
       ) as all_leaves
       GROUP BY status`,
      [employeeId, employeeId]
    );
    
    // Recent leaves (including leave_approval requests)
    const [recentLeaves] = await db.query(
      `SELECT 
         'leave' as type,
         id,
         leave_type,
         start_date,
         days,
         status,
         created_at
       FROM leaves 
       WHERE employee_id = ? 
       
       UNION ALL
       
       SELECT 
         'leave_approval_request' as type,
         id,
         'Leave Approval Request' as leave_type,
         request_date as start_date,
         1 as days,
         status,
         created_at
       FROM employee_requests 
       WHERE employee_id = ? AND request_type = 'leave_approval'
       
       ORDER BY created_at DESC 
       LIMIT 5`,
      [employeeId, employeeId]
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
    
    const { total_leave, casual_leave, sick_leave, permission, women_special } = req.body;
    
    // Get all employee IDs
    const [employees] = await connection.query(
      'SELECT id FROM employees'
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
          'UPDATE leave_balance SET total_leave = ?, casual_leave = ?, sick_leave = ?, permission = ?, women_special = ? WHERE employee_id = ?',
          [total_leave, casual_leave, sick_leave, permission, women_special, employeeId]
        );
      } else {
        // Insert new balance
        await connection.query(
          'INSERT INTO leave_balance (employee_id, total_leave, casual_leave, sick_leave, permission, women_special) VALUES (?, ?, ?, ?, ?, ?)',
          [employeeId, total_leave, casual_leave, sick_leave, permission, women_special]
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
          permission,
          women_special
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
        permission,
        women_special
      FROM leave_balance 
      WHERE total_leave IS NOT NULL 
      OR casual_leave IS NOT NULL 
      OR sick_leave IS NOT NULL 
      OR permission IS NOT NULL
      OR women_special IS NOT NULL
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

const clearLeaveBalanceForAll = async (req, res) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // Get all employee IDs
    const [employees] = await connection.query(
      'SELECT id FROM employees'
    );
    
    if (employees.length === 0) {
      await connection.rollback();
      return res.status(404).json({
        success: false,
        message: 'No active employees found'
      });
    }
    
    // Set all leave balances to NULL for each employee
    for (const employee of employees) {
      const employeeId = employee.id;
      
      // Check if balance exists
      const [existingBalance] = await connection.query(
        'SELECT id FROM leave_balance WHERE employee_id = ?',
        [employeeId]
      );
      
      if (existingBalance.length > 0) {
        // Update existing balance to NULL values (unlimited leaves)
        await connection.query(
          'UPDATE leave_balance SET total_leave = NULL, casual_leave = NULL, sick_leave = NULL, permission = NULL, women_special = NULL WHERE employee_id = ?',
          [employeeId]
        );
      } else {
        // Insert new balance with NULL values (unlimited leaves)
        await connection.query(
          'INSERT INTO leave_balance (employee_id, total_leave, casual_leave, sick_leave, permission, women_special) VALUES (?, NULL, NULL, NULL, NULL, NULL)',
          [employeeId]
        );
      }
    }
    
    await connection.commit();
    
    res.status(200).json({
      success: true,
      message: `Leave balance cleared successfully for ${employees.length} employees. Employees now have unlimited leaves.`,
      data: {
        employeesUpdated: employees.length,
        balance: null
      }
    });
    
  } catch (error) {
    await connection.rollback();
    console.error('Error clearing leave balance:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to clear leave balance'
    });
  } finally {
    connection.release();
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
  getExistingLeaveBalance,
  clearLeaveBalanceForAll
};