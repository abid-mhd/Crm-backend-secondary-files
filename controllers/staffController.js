const db = require("../config/db");

const getEmployeeId = async (req) => {
  console.log('Request user in settings:', req.user);
  if (!req.user || !req.user.id) {
    throw new Error('User not authenticated. Please log in again.');
  }
  
  try {
    // Get employee_id from users table
    const [users] = await db.execute(
      "SELECT employee_id FROM users WHERE id = ?",
      [req.user.id]
    );
    
    if (users.length === 0) {
      throw new Error('User not found in database.');
    }
    
    if (!users[0].employee_id) {
      throw new Error('Employee ID not associated with this user.');
    }
    
    return users[0].employee_id;
  } catch (error) {
    console.error('Error fetching employee ID:', error);
    throw new Error('Error fetching employee information. Please try again.');
  }
};

// Get Staff Dashboard Overview
exports.getStaffDashboardData = async (req, res) => {
  try {
    const staffId = await getEmployeeId(req);

    // Get staff basic info
    const [staffInfo] = await db.execute(
      "SELECT id, employeeName, email, department, position, employeeNo FROM employees WHERE id = ?",
      [staffId]
    );

    if (staffInfo.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Staff member not found" 
      });
    }

    // Get current month and year for filtering
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth() + 1;
    const currentYear = currentDate.getFullYear();

    // Get attendance summary for current month
    const [attendanceSummary] = await db.execute(`
      SELECT 
        COUNT(*) as totalDays,
        SUM(CASE WHEN status = 'Present' THEN 1 ELSE 0 END) as presentDays,
        SUM(CASE WHEN status = 'Absent' THEN 1 ELSE 0 END) as absentDays,
        SUM(CASE WHEN status = 'Late' THEN 1 ELSE 0 END) as lateDays,
        SUM(CASE WHEN status = 'Half Day' THEN 1 ELSE 0 END) as halfDays,
        SUM(CASE WHEN status = 'Paid Leave' THEN 1 ELSE 0 END) as paidLeaveDays,
        SUM(CASE WHEN status = 'Weekly Off' THEN 1 ELSE 0 END) as weeklyOffDays
      FROM attendance 
      WHERE employee_id = ? 
        AND MONTH(date) = ? 
        AND YEAR(date) = ?
    `, [staffId, currentMonth, currentYear]);

    // Get working hours summary
    const [workingHoursSummary] = await db.execute(`
      SELECT 
        COUNT(*) as totalWorkingDays,
        SEC_TO_TIME(AVG(TIME_TO_SEC(TIMEDIFF(check_out, check_in)))) as avgWorkingHours,
        SEC_TO_TIME(SUM(TIME_TO_SEC(TIMEDIFF(check_out, check_in)))) as totalWorkingHours,
        SUM(overtime_hours) as totalOvertimeHours,
        SUM(overtime_amount) as totalOvertimeAmount
      FROM attendance 
      WHERE employee_id = ? 
        AND status = 'Present'
        AND check_in IS NOT NULL 
        AND check_out IS NOT NULL
        AND MONTH(date) = ? 
        AND YEAR(date) = ?
    `, [staffId, currentMonth, currentYear]);

    // Get leaves summary
    const [leavesSummary] = await db.execute(`
      SELECT 
        COUNT(*) as totalLeaves,
        SUM(CASE WHEN status = 'Approved' THEN days ELSE 0 END) as approvedLeaves,
        SUM(CASE WHEN status = 'Applied' THEN days ELSE 0 END) as pendingLeaves,
        SUM(CASE WHEN status = 'Rejected' THEN days ELSE 0 END) as rejectedLeaves
      FROM leaves 
      WHERE employee_id = ? 
        AND MONTH(applied_date) = ? 
        AND YEAR(applied_date) = ?
    `, [staffId, currentMonth, currentYear]);

    // Get transactions summary (salary, overtime, deductions)
    const [transactionsSummary] = await db.execute(`
      SELECT 
        COALESCE(SUM(CASE WHEN payment_type = 'salary' THEN amount ELSE 0 END), 0) as totalSalary,
        COALESCE(SUM(CASE WHEN payment_type = 'overtime' THEN amount ELSE 0 END), 0) as totalOvertime,
        COALESCE(SUM(CASE WHEN payment_type = 'bonus' THEN amount ELSE 0 END), 0) as totalBonus,
        COALESCE(SUM(CASE WHEN payment_type = 'deduction' THEN amount ELSE 0 END), 0) as totalDeductions,
        COALESCE(SUM(amount), 0) as netAmount
      FROM transactions 
      WHERE employee_id = ? 
        AND MONTH(date) = ? 
        AND YEAR(date) = ?
    `, [staffId, currentMonth, currentYear]);

    res.json({
      success: true,
      data: {
        staffInfo: staffInfo[0],
        metrics: {
          attendance: attendanceSummary[0] || {},
          workingHours: workingHoursSummary[0] || {},
          leaves: leavesSummary[0] || {},
          transactions: transactionsSummary[0] || {}
        }
      }
    });

  } catch (err) {
    console.error("Error fetching staff dashboard data:", err);
    res.status(500).json({ 
      success: false,
      message: "Error fetching dashboard data", 
      error: err.message 
    });
  }
};

// Get Staff Attendance Report
exports.getStaffAttendanceReport = async (req, res) => {
  try {
    const staffId = await getEmployeeId(req);
    const { period = 'monthly', startDate, endDate } = req.query;

    let dateFilter = '';
    let groupBy = '';
    let selectField = '';

    switch (period) {
      case 'today':
        dateFilter = "AND a.date = CURDATE()";
        groupBy = 'a.date';
        selectField = 'a.date as period';
        break;
      case 'weekly':
        dateFilter = "AND a.date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)";
        groupBy = 'a.date';
        selectField = 'a.date as period';
        break;
      case 'monthly':
        dateFilter = "AND a.date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
        groupBy = 'a.date';
        selectField = 'a.date as period';
        break;
      case 'yearly':
        dateFilter = "AND a.date >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)";
        groupBy = "DATE_FORMAT(a.date, '%Y-%m')";
        selectField = "DATE_FORMAT(a.date, '%Y-%m') as period";
        break;
      case 'custom':
        if (startDate && endDate) {
          dateFilter = `AND a.date BETWEEN '${startDate}' AND '${endDate}'`;
          groupBy = 'a.date';
          selectField = 'a.date as period';
        }
        break;
      default:
        dateFilter = "AND a.date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
        groupBy = 'a.date';
        selectField = 'a.date as period';
    }

    const [attendanceData] = await db.execute(`
      SELECT 
        ${selectField},
        COUNT(*) as totalDays,
        SUM(CASE WHEN a.status = 'Present' THEN 1 ELSE 0 END) as present,
        SUM(CASE WHEN a.status = 'Absent' THEN 1 ELSE 0 END) as absent,
        SUM(CASE WHEN a.status = 'Late' THEN 1 ELSE 0 END) as late,
        SUM(CASE WHEN a.status = 'Half Day' THEN 1 ELSE 0 END) as halfDay,
        SUM(CASE WHEN a.status = 'Paid Leave' THEN 1 ELSE 0 END) as paidLeave,
        SUM(CASE WHEN a.status = 'Weekly Off' THEN 1 ELSE 0 END) as weeklyOff
      FROM attendance a
      WHERE a.employee_id = ? ${dateFilter}
      GROUP BY ${groupBy}
      ORDER BY a.date ASC
    `, [staffId]);

    res.json({
      success: true,
      data: attendanceData
    });
  } catch (err) {
    console.error("Error fetching staff attendance report:", err);
    res.status(500).json({ 
      success: false,
      message: "Error fetching attendance report", 
      error: err.message 
    });
  }
};

// Get Staff Working Hours Report
exports.getStaffWorkingHoursReport = async (req, res) => {
  try {
    const staffId = await getEmployeeId(req);
    const { period = 'monthly', startDate, endDate } = req.query;

    let dateFilter = '';
    let groupBy = '';
    let selectField = '';

    switch (period) {
      case 'today':
        dateFilter = "AND a.date = CURDATE()";
        groupBy = 'a.date';
        selectField = 'a.date as period';
        break;
      case 'weekly':
        dateFilter = "AND a.date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)";
        groupBy = 'a.date';
        selectField = 'a.date as period';
        break;
      case 'monthly':
        dateFilter = "AND a.date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
        groupBy = 'a.date';
        selectField = 'a.date as period';
        break;
      case 'yearly':
        dateFilter = "AND a.date >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)";
        groupBy = "DATE_FORMAT(a.date, '%Y-%m')";
        selectField = "DATE_FORMAT(a.date, '%Y-%m') as period";
        break;
      case 'custom':
        if (startDate && endDate) {
          dateFilter = `AND a.date BETWEEN '${startDate}' AND '${endDate}'`;
          groupBy = 'a.date';
          selectField = 'a.date as period';
        }
        break;
      default:
        dateFilter = "AND a.date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
        groupBy = 'a.date';
        selectField = 'a.date as period';
    }

    const [workingHoursData] = await db.execute(`
      SELECT 
        ${selectField},
        COUNT(*) as workingDays,
        AVG(TIME_TO_SEC(TIMEDIFF(a.check_out, a.check_in))) as avgWorkingSeconds,
        SUM(TIME_TO_SEC(TIMEDIFF(a.check_out, a.check_in))) as totalWorkingSeconds,
        SUM(a.overtime_hours) as totalOvertimeHours,
        SUM(a.overtime_amount) as totalOvertimeAmount,
        MIN(a.check_in) as earliestCheckIn,
        MAX(a.check_out) as latestCheckOut
      FROM attendance a
      WHERE a.employee_id = ? 
        AND a.status = 'Present'
        AND a.check_in IS NOT NULL 
        AND a.check_out IS NOT NULL
        ${dateFilter}
      GROUP BY ${groupBy}
      ORDER BY a.date ASC
    `, [staffId]);

    // Convert seconds to hours for better readability
    const formattedData = workingHoursData.map(item => ({
      ...item,
      avgWorkingHours: item.avgWorkingSeconds ? (item.avgWorkingSeconds / 3600).toFixed(2) : 0,
      totalWorkingHours: item.totalWorkingSeconds ? (item.totalWorkingSeconds / 3600).toFixed(2) : 0
    }));

    res.json({
      success: true,
      data: formattedData
    });
  } catch (err) {
    console.error("Error fetching staff working hours report:", err);
    res.status(500).json({ 
      success: false,
      message: "Error fetching working hours report", 
      error: err.message 
    });
  }
};

// Get Staff Leaves Report
exports.getStaffLeavesReport = async (req, res) => {
  try {
    const staffId = await getEmployeeId(req);
    const { period = 'monthly', startDate, endDate } = req.query;

    let dateFilter = '';
    let groupBy = '';
    let selectField = '';

    switch (period) {
      case 'today':
        dateFilter = "AND l.applied_date >= CURDATE()";
        groupBy = 'l.applied_date';
        selectField = 'l.applied_date as period';
        break;
      case 'weekly':
        dateFilter = "AND l.applied_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)";
        groupBy = 'l.applied_date';
        selectField = 'l.applied_date as period';
        break;
      case 'monthly':
        dateFilter = "AND l.applied_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
        groupBy = 'l.applied_date';
        selectField = 'l.applied_date as period';
        break;
      case 'yearly':
        dateFilter = "AND l.applied_date >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)";
        groupBy = "DATE_FORMAT(l.applied_date, '%Y-%m')";
        selectField = "DATE_FORMAT(l.applied_date, '%Y-%m') as period";
        break;
      case 'custom':
        if (startDate && endDate) {
          dateFilter = `AND l.applied_date BETWEEN '${startDate}' AND '${endDate}'`;
          groupBy = 'l.applied_date';
          selectField = 'l.applied_date as period';
        }
        break;
      default:
        dateFilter = "AND l.applied_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
        groupBy = 'l.applied_date';
        selectField = 'l.applied_date as period';
    }

    const [leavesData] = await db.execute(`
      SELECT 
        ${selectField},
        COUNT(*) as totalLeaves,
        SUM(CASE WHEN l.status = 'Approved' THEN l.days ELSE 0 END) as approved,
        SUM(CASE WHEN l.status = 'Applied' THEN l.days ELSE 0 END) as pending,
        SUM(CASE WHEN l.status = 'Rejected' THEN l.days ELSE 0 END) as rejected,
        SUM(CASE WHEN l.leave_type = 'Casual Leave' THEN l.days ELSE 0 END) as casualLeave,
        SUM(CASE WHEN l.leave_type = 'Sick Leave' THEN l.days ELSE 0 END) as sickLeave,
        SUM(CASE WHEN l.leave_type = 'Permission' THEN l.days ELSE 0 END) as permission
      FROM leaves l
      WHERE l.employee_id = ? ${dateFilter}
      GROUP BY ${groupBy}
      ORDER BY l.applied_date ASC
    `, [staffId]);

    res.json({
      success: true,
      data: leavesData
    });
  } catch (err) {
    console.error("Error fetching staff leaves report:", err);
    res.status(500).json({ 
      success: false,
      message: "Error fetching leaves report", 
      error: err.message 
    });
  }
};

// Get Staff Transactions Report
exports.getStaffTransactionsReport = async (req, res) => {
  try {
    const staffId = await getEmployeeId(req);
    const { period = 'monthly', startDate, endDate } = req.query;

    let dateFilter = '';
    let groupBy = '';
    let selectField = '';

    switch (period) {
      case 'today':
        dateFilter = "AND t.date = CURDATE()";
        groupBy = 't.date';
        selectField = 't.date as period';
        break;
      case 'weekly':
        dateFilter = "AND t.date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)";
        groupBy = 't.date';
        selectField = 't.date as period';
        break;
      case 'monthly':
        dateFilter = "AND t.date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
        groupBy = 't.date';
        selectField = 't.date as period';
        break;
      case 'yearly':
        dateFilter = "AND t.date >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)";
        groupBy = "DATE_FORMAT(t.date, '%Y-%m')";
        selectField = "DATE_FORMAT(t.date, '%Y-%m') as period";
        break;
      case 'custom':
        if (startDate && endDate) {
          dateFilter = `AND t.date BETWEEN '${startDate}' AND '${endDate}'`;
          groupBy = 't.date';
          selectField = 't.date as period';
        }
        break;
      default:
        dateFilter = "AND t.date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)";
        groupBy = 't.date';
        selectField = 't.date as period';
    }

    const [transactionsData] = await db.execute(`
      SELECT 
        ${selectField},
        COUNT(*) as totalTransactions,
        SUM(CASE WHEN t.payment_type = 'salary' THEN t.amount ELSE 0 END) as salary,
        SUM(CASE WHEN t.payment_type = 'overtime' THEN t.amount ELSE 0 END) as overtime,
        SUM(CASE WHEN t.payment_type = 'bonus' THEN t.amount ELSE 0 END) as bonus,
        SUM(CASE WHEN t.payment_type = 'deduction' THEN t.amount ELSE 0 END) as deductions,
        SUM(t.amount) as netAmount
      FROM transactions t
      WHERE t.employee_id = ? ${dateFilter}
      GROUP BY ${groupBy}
      ORDER BY t.date ASC
    `, [staffId]);

    res.json({
      success: true,
      data: transactionsData
    });
  } catch (err) {
    console.error("Error fetching staff transactions report:", err);
    res.status(500).json({ 
      success: false,
      message: "Error fetching transactions report", 
      error: err.message 
    });
  }
};