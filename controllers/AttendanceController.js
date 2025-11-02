const db = require("../config/db");
const { validationResult } = require('express-validator');

const getEmployeeId = async (req) => {
  console.log('Request user in settings:', req.user);
  if (!req.user || !req.user.id) {
    throw new Error('User not authenticated. Please log in again.');
  }
  
  try {
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

// Get all employees
exports.getEmployees = async (req, res) => {
  try {
    const [employees] = await db.query(`
      SELECT 
        id, 
        name, 
        email, 
        phone as mobileNumber,
        department, 
        position, 
        status, 
        check_in as checkIn, 
        check_out as checkOut,
        last_month_due as lastMonthDue,
        balance,
        salary,
        active
      FROM employees 
      WHERE active = 1
    `);
    res.json(employees);
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Get employees with today's attendance
exports.getEmployeesWithAttendance = async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date) : new Date().toISOString().split('T')[0];

    const [employees] = await db.query(`
      SELECT 
        e.id,
        e.name,
        e.phone as mobileNumber,
        e.department,
        e.position,
        e.last_month_due as lastMonthDue,
        e.balance,
        e.salary,
        a.status,
        a.check_in as checkIn,
        a.check_out as checkOut,
        a.overtime_hours as overtimeHours,
        a.overtime_rate as overtimeRate,
        a.overtime_amount as overtimeAmount,
        a.location_data as locationData
      FROM employees e
      LEFT JOIN attendance a ON e.id = a.employee_id 
        AND DATE(a.date) = ?
      WHERE e.active = 1
      ORDER BY e.name
    `, [targetDate]);

    // Parse location data if it exists
    const employeesWithLocation = employees.map(emp => {
      if (emp.locationData) {
        try {
          emp.locationData = JSON.parse(emp.locationData);
        } catch (e) {
          emp.locationData = null;
        }
      }
      return emp;
    });

    res.json(employeesWithLocation);
  } catch (error) {
    console.error("Error fetching employees with attendance:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Add new employee
exports.addEmployee = async (req, res) => {
  try {
    const { 
      name, 
      email, 
      phone, 
      department, 
      position, 
      salary,
      last_month_due = 0,
      balance = 0
    } = req.body;

    const meta = JSON.stringify({
      addedBy: "system",
      internalNote: "Added via backend",
      timestamp: new Date().toISOString(),
    });

    await db.query(
      `INSERT INTO employees (
        name, email, phone, department, position, salary, 
        last_month_due, balance, meta, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [name, email, phone, department, position, salary, 
       last_month_due, balance, meta]
    );

    res.status(201).json({ message: "Employee added successfully" });
  } catch (error) {
    console.error("Error adding employee:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Update employee details
exports.updateEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      name, 
      department, 
      position, 
      phone,
      salary,
      last_month_due,
      balance
    } = req.body;

    const meta = JSON.stringify({
      updatedBy: "system",
      timestamp: new Date().toISOString(),
    });

    await db.query(
      `UPDATE employees
       SET name=?, department=?, position=?, phone=?, 
           salary=?, last_month_due=?, balance=?, meta=?
       WHERE id=?`,
      [name, department, position, phone, salary, 
       last_month_due, balance, meta, id]
    );

    res.json({ message: "Employee updated successfully" });
  } catch (error) {
    console.error("Error updating employee:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Delete employee (soft delete)
exports.deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    await db.query("UPDATE employees SET active = 0 WHERE id=?", [id]);
    res.json({ message: "Employee deleted successfully" });
  } catch (error) {
    console.error("Error deleting employee:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Get attendance summary for a specific date
exports.getAttendanceSummary = async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date) : new Date().toISOString().split('T')[0];

    const [summary] = await db.query(`
      SELECT 
        COUNT(CASE WHEN status = 'Present' THEN 1 END) as present,
        COUNT(CASE WHEN status = 'Absent' THEN 1 END) as absent,
        COUNT(CASE WHEN status = 'Half Day' THEN 1 END) as halfDay,
        COUNT(CASE WHEN status = 'Paid Leave' THEN 1 END) as paidLeave,
        COUNT(CASE WHEN status = 'Weekly Off' THEN 1 END) as weeklyOff
      FROM attendance 
      WHERE DATE(date) = ?
    `, [targetDate]);

    const result = {
      present: summary[0]?.present || 0,
      absent: summary[0]?.absent || 0,
      halfDay: summary[0]?.halfDay || 0,
      paidLeave: summary[0]?.paidLeave || 0,
      weeklyOff: summary[0]?.weeklyOff || 0
    };

    res.json(result);
  } catch (error) {
    console.error("Error fetching attendance summary:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Mark attendance with location
exports.markAttendance = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      employeeId, 
      status, 
      date, 
      checkIn, 
      checkOut, 
      remarks = '',
      locationData = null 
    } = req.body;
    
    const targetDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    console.log('Marking attendance for:', { 
      employeeId, 
      status, 
      targetDate, 
      checkIn, 
      checkOut,
      locationData 
    });

    // Validate location data structure if provided
    let locationJson = null;
    if (locationData) {
      try {
        locationJson = JSON.stringify({
          latitude: locationData.latitude,
          longitude: locationData.longitude,
          accuracy: locationData.accuracy,
          address: locationData.address || null,
          timestamp: new Date().toISOString(),
          source: locationData.source || 'browser'
        });
      } catch (error) {
        console.error('Error parsing location data:', error);
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid location data format' 
        });
      }
    }

    // Check if attendance already exists
    const [existing] = await db.query(
      "SELECT id, check_in, check_out FROM attendance WHERE employee_id = ? AND DATE(date) = ?",
      [employeeId, targetDate]
    );

    let updateData = { 
      status, 
      remarks, 
      updated_at: new Date() 
    };
    
    // Add location data if provided
    if (locationJson) {
      updateData.location_data = locationJson;
    }
    
    // Only update check_in if it's provided and not already set
    if (checkIn && (!existing[0]?.check_in || existing[0]?.check_in === '00:00:00')) {
      updateData.check_in = checkIn;
    }
    
    // Only update check_out if it's provided
    if (checkOut) {
      updateData.check_out = checkOut;
    }

    if (existing.length > 0) {
      // Update existing attendance
      await db.query(
        `UPDATE attendance 
         SET ? 
         WHERE employee_id = ? AND DATE(date) = ?`,
        [updateData, employeeId, targetDate]
      );
      
      console.log('Updated existing attendance record');
    } else {
      // Create new attendance record
      const newData = {
        employee_id: employeeId,
        date: targetDate,
        status: status,
        remarks: remarks,
        created_at: new Date(),
        updated_at: new Date()
      };
      
      if (checkIn) newData.check_in = checkIn;
      if (checkOut) newData.check_out = checkOut;
      if (locationJson) newData.location_data = locationJson;
      
      await db.query(
        `INSERT INTO attendance SET ?`,
        [newData]
      );
      
      console.log('Created new attendance record');
    }

    // Update employee status in employees table
    await db.query(
      `UPDATE employees 
       SET status = ?, updatedAt = NOW()
       WHERE id = ?`,
      [status, employeeId]
    );

    console.log('Updated employee status in employees table');

    res.json({ 
      success: true, 
      message: 'Attendance marked successfully',
      locationRecorded: !!locationData 
    });
  } catch (error) {
    console.error('Error marking attendance:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Add overtime with location (optional)
exports.addOvertime = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      employeeId, 
      hours, 
      rate, 
      type, 
      amount, 
      date, 
      calculationType,
      locationData = null 
    } = req.body;
    
    const targetDate = date ? new Date(date) : new Date().toISOString().split('T')[0];

    // Convert rate from string with commas to decimal
    const cleanRate = parseFloat(rate.replace(/,/g, ''));
    const cleanAmount = parseFloat(amount.toString().replace(/,/g, ''));

    // Prepare location data if provided
    let locationJson = null;
    if (locationData) {
      try {
        locationJson = JSON.stringify({
          latitude: locationData.latitude,
          longitude: locationData.longitude,
          accuracy: locationData.accuracy,
          address: locationData.address || null,
          timestamp: new Date().toISOString(),
          source: locationData.source || 'browser'
        });
      } catch (error) {
        console.error('Error parsing location data for overtime:', error);
      }
    }

    // Check if attendance record exists
    const [existing] = await db.query(
      "SELECT id FROM attendance WHERE employee_id = ? AND DATE(date) = ?",
      [employeeId, targetDate]
    );

    if (existing.length > 0) {
      // Update existing record with overtime
      const updateData = {
        overtime_hours: hours,
        overtime_rate: cleanRate,
        overtime_type: type,
        overtime_amount: cleanAmount,
        overtime_calculation_type: calculationType,
        updated_at: new Date()
      };

      // Add location data if provided
      if (locationJson) {
        updateData.location_data = locationJson;
      }

      await db.query(
        `UPDATE attendance 
         SET ?
         WHERE employee_id = ? AND DATE(date) = ?`,
        [updateData, employeeId, targetDate]
      );
    } else {
      // Create new record with overtime
      const newData = {
        employee_id: employeeId,
        date: targetDate,
        status: 'Present',
        overtime_hours: hours,
        overtime_rate: cleanRate,
        overtime_type: type,
        overtime_amount: cleanAmount,
        overtime_calculation_type: calculationType,
        created_at: new Date(),
        updated_at: new Date()
      };

      // Add location data if provided
      if (locationJson) {
        newData.location_data = locationJson;
      }

      await db.query(
        `INSERT INTO attendance SET ?`,
        [newData]
      );
    }

    res.json({ 
      success: true, 
      message: 'Overtime added successfully',
      locationRecorded: !!locationData 
    });
  } catch (error) {
    console.error('Error adding overtime:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get attendance history for an employee with location data
exports.getAttendanceHistory = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { month, year } = req.query;

    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    const [history] = await db.query(`
      SELECT 
        id,
        date,
        status,
        check_in as checkIn,
        check_out as checkOut,
        overtime_hours as overtimeHours,
        overtime_amount as overtimeAmount,
        remarks,
        location_data as locationData
      FROM attendance 
      WHERE employee_id = ? 
        AND date BETWEEN ? AND ?
      ORDER BY date DESC
    `, [employeeId, startDate, endDate]);

    // Parse location data for each record
    const historyWithLocation = history.map(record => {
      if (record.locationData) {
        try {
          record.locationData = JSON.parse(record.locationData);
        } catch (e) {
          record.locationData = null;
        }
      }
      return record;
    });

    res.json({ success: true, data: historyWithLocation });
  } catch (error) {
    console.error('Error fetching attendance history:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Update attendance with location
exports.updateAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      status, 
      checkIn, 
      checkOut, 
      overtimeHours, 
      remarks, 
      date,
      locationData = null 
    } = req.body;

    console.log('Updating attendance:', { 
      id, 
      status, 
      checkIn, 
      checkOut, 
      overtimeHours, 
      remarks,
      locationData 
    });

    // Check if attendance record exists
    const [existing] = await db.query(
      "SELECT id FROM attendance WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Attendance record not found' });
    }

    // Prepare location data if provided
    let locationJson = null;
    if (locationData) {
      try {
        locationJson = JSON.stringify({
          latitude: locationData.latitude,
          longitude: locationData.longitude,
          accuracy: locationData.accuracy,
          address: locationData.address || null,
          timestamp: new Date().toISOString(),
          source: locationData.source || 'manual_update'
        });
      } catch (error) {
        console.error('Error parsing location data for update:', error);
      }
    }

    // Build update object with only provided fields
    const updateFields = {
      updated_at: new Date()
    };

    if (status) updateFields.status = status;
    if (checkIn) updateFields.check_in = checkIn;
    if (checkOut) updateFields.check_out = checkOut;
    if (overtimeHours) updateFields.overtime_hours = overtimeHours;
    if (remarks) updateFields.remarks = remarks;
    if (locationJson) updateFields.location_data = locationJson;

    await db.query(
      `UPDATE attendance 
       SET ?
       WHERE id = ?`,
      [updateFields, id]
    );




    res.json({ 
      success: true, 
      message: 'Attendance updated successfully',
      locationUpdated: !!locationData 
    });
  } catch (error) {
    console.error('Error updating attendance:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Today's attendance with location data
exports.todayAttendance = async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    console.log('Fetching today attendance for date:', targetDate);

    const [attendance] = await db.query(`
      SELECT 
        a.id as attendance_id,
        a.employee_id,
        a.status,
        a.check_in,
        a.check_out,
        a.overtime_hours,
        a.remarks,
        a.location_data as locationData,
        a.date as attendance_date,
        e.id as employee_id,
        e.employeeName as employee_name,
        e.department,
        e.position,
        e.phone,
        e.balance,
        e.last_month_due
      FROM attendance a
      JOIN employees e ON a.employee_id = e.id
      WHERE DATE(a.date) = ?
      ORDER BY e.employeeName
    `, [targetDate]);

    // Don't parse location data here - let frontend handle it
    // Just return the raw data as is
    console.log(`Found ${attendance.length} attendance records for ${targetDate}`);

    // Debug: Check first record's location data
    if (attendance.length > 0) {
      console.log('First record location data type:', typeof attendance[0].locationData);
      console.log('First record location data:', attendance[0].locationData);
    }

    res.json({ 
      success: true, 
      data: attendance, // Return raw data without parsing
      count: attendance.length,
      date: targetDate
    });
  } catch (error) {
    console.error('Error fetching today attendance:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching today attendance',
      error: error.message 
    });
  }
};

// Get my attendance with location data
exports.getMyAttendance = async (req, res) => {
  try {
    const { month, year } = req.query;
    const employeeId = await getEmployeeId(req);

    if (!employeeId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Employee ID not found' 
      });
    }

    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    console.log('Fetching my attendance for:', { employeeId, startDate, endDate });

    const [attendance] = await db.query(`
      SELECT 
        id,
        date,
        status,
        check_in as checkIn,
        check_out as checkOut,
        overtime_hours as overtimeHours,
        overtime_amount as overtimeAmount,
        remarks,
        location_data as locationData
      FROM attendance 
      WHERE employee_id = ? 
        AND date BETWEEN ? AND ?
      ORDER BY date DESC
    `, [employeeId, startDate, endDate]);

    // Parse location data for each record
    const attendanceWithLocation = attendance.map(record => {
      if (record.locationData) {
        try {
          record.locationData = JSON.parse(record.locationData);
        } catch (e) {
          record.locationData = null;
        }
      }
      return record;
    });

    res.json({
      success: true,
      data: attendanceWithLocation,
      count: attendance.length
    });
  } catch (error) {
    console.error('Get my attendance error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching attendance' 
    });
  }
};

// Get attendance by location (for reporting/analytics)
exports.getAttendanceByLocation = async (req, res) => {
  try {
    const { date, latitude, longitude, radius = 1000 } = req.query; // radius in meters
    
    const targetDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    // Get all attendance for the date
    const [attendance] = await db.query(`
      SELECT 
        a.id,
        a.employee_id,
        a.status,
        a.check_in,
        a.check_out,
        a.location_data,
        e.name as employee_name,
        e.department
      FROM attendance a
      JOIN employees e ON a.employee_id = e.id
      WHERE DATE(a.date) = ?
        AND a.location_data IS NOT NULL
    `, [targetDate]);

    // Filter by proximity if coordinates provided
    let filteredAttendance = attendance;
    if (latitude && longitude) {
      filteredAttendance = attendance.filter(record => {
        try {
          const location = JSON.parse(record.location_data);
          if (location.latitude && location.longitude) {
            const distance = calculateDistance(
              parseFloat(latitude),
              parseFloat(longitude),
              parseFloat(location.latitude),
              parseFloat(location.longitude)
            );
            return distance <= (radius / 1000); // Convert to kilometers
          }
        } catch (e) {
          return false;
        }
        return false;
      });
    }

    // Parse location data
    const attendanceWithLocation = filteredAttendance.map(record => {
      if (record.location_data) {
        try {
          record.location_data = JSON.parse(record.location_data);
        } catch (e) {
          record.location_data = null;
        }
      }
      return record;
    });

    res.json({
      success: true,
      data: attendanceWithLocation,
      count: attendanceWithLocation.length
    });
  } catch (error) {
    console.error('Error fetching attendance by location:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching attendance by location' 
    });
  }
};

// Helper function to calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c; // Distance in kilometers
  return distance;
}

exports.getAttendanceSettings = async (req, res) => {
  try {
    const [settings] = await db.query(`
      SELECT * FROM attendance_settings 
      ORDER BY created_at DESC, id DESC 
      LIMIT 1
    `);
    
    // Check if any settings exist
    if (settings && settings.length > 0) {
      try {
        const latestSetting = settings[0];
        
        // Parse the settings_data if it's a JSON string
        const settingsData = typeof latestSetting.settings_data === 'string' 
          ? JSON.parse(latestSetting.settings_data)
          : latestSetting.settings_data;
        
        res.json({
          ...settingsData,
          // Include metadata if needed
          id: latestSetting.id,
          created_at: latestSetting.created_at,
          updated_at: latestSetting.updated_at
        });
      } catch (parseError) {
        console.error('Error parsing settings data:', parseError);
        // Return default settings if parsing fails
        returnDefaultSettings(res);
      }
    } else {
      // Return default settings if no settings found
      returnDefaultSettings(res);
    }
  } catch (error) {
    console.error('Error fetching attendance settings:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// Helper function to return default settings
function returnDefaultSettings(res) {
  const defaultSettings = {
    enableDailyReminder: false,
    reminderTime: '08:55',
    markPresentByDefault: false,
    workingHours: '09:00',
    weeklyOff: {
      sun: true, 
      mon: false, 
      tue: false, 
      wed: false, 
      thu: false, 
      fri: false, 
      sat: false
    }
  };
  res.json(defaultSettings);
}

exports.saveAttendanceSettings = async (req, res) => {
  try {
    const settings = req.body;
    
    // Check if settings already exist
    const [existing] = await db.query(`
      SELECT * FROM attendance_settings WHERE id = 1
    `);
    
    if (existing && existing.length > 0) {
      // Update existing settings
      await db.query(`
        UPDATE attendance_settings 
        SET settings_data = ?, updated_at = NOW() 
        WHERE id = 1
      `, [JSON.stringify(settings)]);
    } else {
      // Insert new settings
      await db.query(`
        INSERT INTO attendance_settings (id, settings_data, created_at, updated_at)
        VALUES (1, ?, NOW(), NOW())
      `, [JSON.stringify(settings)]);
    }
    
    res.json({ message: 'Settings saved successfully' });
  } catch (error) {
    console.error('Error saving attendance settings:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

exports.saveAttendanceSettings = async (req, res) => {
  try {
    const settings = req.body;
    
    const [existing] = await db.query(`
      SELECT id FROM attendance_settings WHERE id = 1
    `);

    if (existing.length > 0) {
      // Update existing settings
      await db.query(`
        UPDATE attendance_settings 
        SET settings_data = ?, updated_at = NOW()
        WHERE id = 1
      `, [JSON.stringify(settings)]);
    } else {
      // Insert new settings
      await db.query(`
        INSERT INTO attendance_settings (id, settings_data, created_at, updated_at)
        VALUES (1, ?, NOW(), NOW())
      `, [JSON.stringify(settings)]);
    }

    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (error) {
    console.error('Error saving attendance settings:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get employee details with extended information
exports.getEmployeeDetails = async (req, res) => {
  try {
    const { id } = req.params;
    
    const [employee] = await db.query(`
      SELECT 
        e.*,
        COALESCE(SUM(a.overtime_amount), 0) as total_overtime,
        COUNT(a.id) as total_attendance_records
      FROM employees e
      LEFT JOIN attendance a ON e.id = a.employee_id
      WHERE e.id = ?
      GROUP BY e.id
    `, [id]);

    if (employee.length === 0) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    res.json({ success: true, data: employee[0] });
  } catch (error) {
    console.error('Error fetching employee details:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get employee payroll summary
exports.getEmployeePayroll = async (req, res) => {
  try {
    const { employeeId, month, year } = req.query;
    
    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    // Get attendance summary with overtime
    const [attendanceSummary] = await db.query(`
      SELECT 
        COUNT(CASE WHEN status = 'Present' THEN 1 END) as present_days,
        COUNT(CASE WHEN status = 'Absent' THEN 1 END) as absent_days,
        COUNT(CASE WHEN status = 'Half Day' THEN 1 END) as half_days,
        COUNT(CASE WHEN status = 'Paid Leave' THEN 1 END) as paid_leaves,
        COUNT(CASE WHEN status = 'Weekly Off' THEN 1 END) as weekly_off,
        COUNT(CASE WHEN overtime_amount > 0 THEN 1 END) as overtime_days,
        COALESCE(SUM(overtime_amount), 0) as total_overtime,
        COALESCE(SUM(overtime_hours), 0) as total_overtime_hours,
        COALESCE(AVG(overtime_rate), 0) as avg_overtime_rate
      FROM attendance 
      WHERE employee_id = ? 
        AND date BETWEEN ? AND ?
    `, [employeeId, startDate, endDate]);

    // Get employee basic salary and details
    const [employeeData] = await db.query(`
      SELECT 
        salary,
        last_month_due,
        balance
      FROM employees 
      WHERE id = ?
    `, [employeeId]);

    let salaryData = {};
    try {
      salaryData = typeof employeeData[0]?.salary === 'string' 
        ? JSON.parse(employeeData[0].salary) 
        : employeeData[0]?.salary || {};
    } catch (e) {
      salaryData = {};
    }

    const result = {
      ...attendanceSummary[0],
      basic_salary: salaryData.basicSalary || 0,
      allowances: salaryData.otherAllowances || 0,
      deductions: salaryData.totalDeductions || 0,
      last_month_due: employeeData[0]?.last_month_due || 0,
      current_balance: employeeData[0]?.balance || 0
    };

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error fetching payroll data:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }

};

// exports.updateAttendance = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const { status, checkIn, checkOut, overtimeHours, remarks, date } = req.body;

//     console.log('Updating attendance:', { id, status, checkIn, checkOut, overtimeHours, remarks });

//     // Check if attendance record exists
//     const [existing] = await db.query(
//       "SELECT id FROM attendance WHERE id = ?",
//       [id]
//     );

//     if (existing.length === 0) {
//       return res.status(404).json({ success: false, message: 'Attendance record not found' });
//     }

//     // Build update object with only provided fields
//     const updateFields = {
//       updated_at: new Date()
//     };

//     if (status) updateFields.status = status;
//     if (checkIn) updateFields.check_in = checkIn;
//     if (checkOut) updateFields.check_out = checkOut;
//     if (overtimeHours) updateFields.overtime_hours = overtimeHours;
//     if (remarks) updateFields.remarks = remarks;

//     await db.query(
//       `UPDATE attendance 
//        SET ?
//        WHERE id = ?`,
//       [updateFields, id]
//     );

//     res.json({ success: true, message: 'Attendance updated successfully' });
//   } catch (error) {
//     console.error('Error updating attendance:', error);
//     res.status(500).json({ success: false, message: 'Server error' });
//   }
// };

// Delete attendance record
exports.deleteAttendance = async (req, res) => {
  try {
    const { id } = req.params;

    console.log('Deleting attendance record:', id);

    // Check if attendance record exists
    const [existing] = await db.query(
      "SELECT id FROM attendance WHERE id = ?",
      [id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Attendance record not found' });
    }

    await db.query('DELETE FROM attendance WHERE id = ?', [id]);

    res.json({ success: true, message: 'Attendance record deleted successfully' });
  } catch (error) {
    console.error('Error deleting attendance:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// exports.todayAttendance = async (req, res) => {
//   try {
//     const { date } = req.query;
//     const targetDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

//     console.log('Fetching today attendance for date:', targetDate);

//     const [attendance] = await db.query(`
//       SELECT 
//         a.id as attendance_id,
//         a.employee_id,
//         a.status,
//         a.check_in,
//         a.check_out,
//         a.overtime_hours,
//         a.remarks,
//         a.date as attendance_date,
//         e.id as employee_id,
//         e.employeeName as employee_name,
//         e.department,
//         e.position,
//         e.phone,
//         e.balance,
//         e.last_month_due
//       FROM attendance a
//       JOIN employees e ON a.employee_id = e.id
//       WHERE DATE(a.date) = ?
//       ORDER BY e.employeeName
//     `, [targetDate]);

//     console.log(`Found ${attendance.length} attendance records for ${targetDate}`);

//     res.json({ 
//       success: true, 
//       data: attendance,
//       count: attendance.length,
//       date: targetDate
//     });
//   } catch (error) {
//     console.error('Error fetching today attendance:', error);
//     res.status(500).json({ 
//       success: false, 
//       message: 'Error fetching today attendance',
//       error: error.message 
//     });
//   }
// };

// exports.markAttendance = async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({ errors: errors.array() });
//     }

//     const { employeeId, status, date, checkIn, checkOut, remarks = '' } = req.body;
    
//     const targetDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

//     console.log('Marking attendance for:', { employeeId, status, targetDate, checkIn, checkOut });

//     // Check if attendance already exists
//     const [existing] = await db.query(
//       "SELECT id, check_in, check_out FROM attendance WHERE employee_id = ? AND DATE(date) = ?",
//       [employeeId, targetDate]
//     );

//     let updateData = { status, remarks, updated_at: new Date() };
    
//     // Only update check_in if it's provided and not already set
//     if (checkIn && (!existing[0]?.check_in || existing[0]?.check_in === '00:00:00')) {
//       updateData.check_in = checkIn;
//     }
    
//     // Only update check_out if it's provided
//     if (checkOut) {
//       updateData.check_out = checkOut;
//     }

//     if (existing.length > 0) {
//       // Update existing attendance
//       await db.query(
//         `UPDATE attendance 
//          SET ? 
//          WHERE employee_id = ? AND DATE(date) = ?`,
//         [updateData, employeeId, targetDate]
//       );
      
//       console.log('Updated existing attendance record');
//     } else {
//       // Create new attendance record
//       const newData = {
//         employee_id: employeeId,
//         date: targetDate,
//         status: status,
//         remarks: remarks,
//         created_at: new Date(),
//         updated_at: new Date()
//       };
      
//       if (checkIn) newData.check_in = checkIn;
//       if (checkOut) newData.check_out = checkOut;
      
//       await db.query(
//         `INSERT INTO attendance SET ?`,
//         [newData]
//       );
      
//       console.log('Created new attendance record');
//     }

//     // Update employee status in employees table
//     await db.query(
//       `UPDATE employees 
//        SET status = ?, updatedAt = NOW()
//        WHERE id = ?`,
//       [status, employeeId]
//     );

//     console.log('Updated employee status in employees table');

//     res.json({ success: true, message: 'Attendance marked successfully' });
//   } catch (error) {
//     console.error('Error marking attendance:', error);
//     res.status(500).json({ success: false, message: 'Server error' });
//   }
// };

// Save attendance settings
exports.saveAttendanceSettings = async (req, res) => {
  try {
    const settings = req.body;
    
    // Validate required fields
    if (!settings.workingHours || !settings.weeklyOff) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required settings fields' 
      });
    }

    const [existing] = await db.query(`
      SELECT id FROM attendance_settings WHERE id = 1
    `);

    const settingsJson = JSON.stringify(settings);
    const now = new Date();

    if (existing.length > 0) {
      // Update existing settings
      await db.query(`
        UPDATE attendance_settings 
        SET settings_data = ?, updated_at = ?
        WHERE id = 1
      `, [settingsJson, now]);
    } else {
      // Insert new settings
      await db.query(`
        INSERT INTO attendance_settings (id, settings_data, created_at, updated_at)
        VALUES (1, ?, ?, ?)
      `, [settingsJson, now, now]);
    }

    res.json({ 
      success: true, 
      message: 'Settings saved successfully',
      data: settings 
    });
  } catch (error) {
    console.error('Error saving attendance settings:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while saving settings' 
    });
  }
};

exports.getMyAttendance = async (req, res) => {
  try {
    const { month, year } = req.query;
    const employeeId = await getEmployeeId(req);

    if (!employeeId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Employee ID not found' 
      });
    }

    // Calculate date range for the month
    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    console.log('Fetching my attendance for:', { employeeId, startDate, endDate });

    const [attendance] = await db.query(`
      SELECT 
        id,
        date,
        status,
        check_in as checkIn,
        check_out as checkOut,
        overtime_hours as overtimeHours,
        overtime_amount as overtimeAmount,
        remarks
      FROM attendance 
      WHERE employee_id = ? 
        AND date BETWEEN ? AND ?
      ORDER BY date DESC
    `, [employeeId, startDate, endDate]);

    res.json({
      success: true,
      data: attendance,
      count: attendance.length
    });
  } catch (error) {
    console.error('Get my attendance error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching attendance' 
    });
  }
};

// Get logged-in user's attendance summary
exports.getMyAttendanceSummary = async (req, res) => {
  try {
    const { month, year } = req.query;
    const employeeId = await getEmployeeId(req);

    if (!employeeId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Employee ID not found' 
      });
    }

    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    console.log('Fetching my attendance summary for:', { employeeId, startDate, endDate });

    const [attendance] = await db.query(`
      SELECT 
        status,
        COUNT(*) as count
      FROM attendance 
      WHERE employee_id = ? 
        AND date BETWEEN ? AND ?
      GROUP BY status
    `, [employeeId, startDate, endDate]);

    // Initialize summary with zeros
    const summary = {
      present: 0,
      absent: 0,
      halfDay: 0,
      paidLeave: 0,
      weeklyOff: 0,
      total: 0
    };

    // Update counts based on database results
    attendance.forEach(item => {
      const status = item.status.toLowerCase().replace(' ', '');
      if (summary.hasOwnProperty(status)) {
        summary[status] = item.count;
      }
    });

    // Calculate total
    summary.total = attendance.reduce((total, item) => total + parseInt(item.count), 0);

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    console.error('Get my attendance summary error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching attendance summary' 
    });
  }
};

// Get logged-in user's attendance statistics for charts
exports.getMyAttendanceStats = async (req, res) => {
  try {
    const { year } = req.query;
    const employeeId = await getEmployeeId(req);

    if (!employeeId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Employee ID not found' 
      });
    }

    console.log('Fetching my attendance stats for year:', year);

    const monthlyStats = [];
    
    // Get stats for each month of the year
    for (let month = 1; month <= 12; month++) {
      const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
      const endDate = new Date(year, month, 0).toISOString().split('T')[0];

      const [attendance] = await db.query(`
        SELECT 
          status,
          COUNT(*) as count
        FROM attendance 
        WHERE employee_id = ? 
          AND date BETWEEN ? AND ?
        GROUP BY status
      `, [employeeId, startDate, endDate]);

      // Initialize monthly stats
      const monthStats = {
        month: month,
        present: 0,
        absent: 0,
        halfDay: 0,
        paidLeave: 0,
        weeklyOff: 0,
        total: 0
      };

      // Update counts based on database results
      attendance.forEach(item => {
        const status = item.status.toLowerCase().replace(' ', '');
        if (monthStats.hasOwnProperty(status)) {
          monthStats[status] = item.count;
        }
      });

      // Calculate total
      monthStats.total = attendance.reduce((total, item) => total + parseInt(item.count), 0);

      monthlyStats.push(monthStats);
    }

    res.json({
      success: true,
      data: monthlyStats
    });
  } catch (error) {
    console.error('Get my attendance stats error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching attendance statistics' 
    });
  }
};