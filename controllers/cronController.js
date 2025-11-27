const db = require("../config/db");
const { exec } = require('child_process');
const os = require('os');

// Helper function to get weekdays between two dates (excluding weekends)
function getWeekdaysBetweenDates(startDate, endDate) {
  const weekdays = [];
  const currentDate = new Date(startDate);
  const lastDate = new Date(endDate);
  
  while (currentDate <= lastDate) {
    const dayOfWeek = currentDate.getDay();
    // Skip weekends (0 = Sunday, 6 = Saturday)
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      weekdays.push(new Date(currentDate));
    }
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return weekdays;
}

// Helper function to check if date is weekend
function isWeekend(date) {
  const dayOfWeek = date.getDay();
  return dayOfWeek === 0 || dayOfWeek === 6; // 0 = Sunday, 6 = Saturday
}

// Get attendance settings (weekly off days)
async function getAttendanceSettings() {
  try {
    const [settings] = await db.query(`
      SELECT settings_data FROM attendance_settings 
      ORDER BY created_at DESC LIMIT 1
    `);
    
    if (settings && settings.length > 0) {
      const settingsData = typeof settings[0].settings_data === 'string' 
        ? JSON.parse(settings[0].settings_data) 
        : settings[0].settings_data;
      
      return settingsData;
    }
    
    // Return default settings if none found
    return {
      weeklyOff: {
        sun: true, 
        mon: false, 
        tue: false, 
        wed: false, 
        thu: false, 
        fri: false, 
        sat: true
      }
    };
  } catch (error) {
    console.error('Error fetching attendance settings:', error);
    return {
      weeklyOff: {
        sun: true, 
        mon: false, 
        tue: false, 
        wed: false, 
        thu: false, 
        fri: false, 
        sat: true
      }
    };
  }
}

// Check if date is weekly off based on settings
function isWeeklyOff(date, settings) {
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dayOfWeek = date.getDay();
  const dayName = dayNames[dayOfWeek];
  
  return settings.weeklyOff[dayName] === true;
}

// TEMPORARY FUNCTION: Helper to get week of month (1st, 2nd, 3rd, 4th, 5th) - FOR MANUAL BACKFILL ONLY
function getWeekOfMonth(date) {
  const firstDayOfMonth = new Date(date.getFullYear(), date.getMonth(), 1);
  const firstDayOfWeek = firstDayOfMonth.getDay(); // 0 = Sunday
  
  const offset = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1; // Adjust for Monday start
  const dayOfMonth = date.getDate();
  
  return Math.ceil((dayOfMonth + offset) / 7);
}

// TEMPORARY FUNCTION: Get working days with alternative Saturdays - FOR MANUAL BACKFILL ONLY
function getWorkingDaysWithAlternativeSaturdays(startDate, endDate) {
  const workingDays = [];
  const current = new Date(startDate);
  const end = new Date(endDate);
  
  while (current <= end) {
    const dayOfWeek = current.getDay();
    const isSaturday = dayOfWeek === 6;
    const isSunday = dayOfWeek === 0;
    
    if (!isSunday) {
      if (!isSaturday) {
        // Monday to Friday - always include
        workingDays.push(new Date(current));
      } else {
        // Saturday - include only 1st, 3rd, and 5th
        const weekOfMonth = getWeekOfMonth(current);
        if ([1, 3, 5].includes(weekOfMonth)) {
          workingDays.push(new Date(current));
        }
      }
    }
    
    current.setDate(current.getDate() + 1);
  }
  
  return workingDays;
}

// Daily cron job to mark absent employees for today
exports.dailyAbsentMarking = async (req, res = null) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();
    
    console.log('🔄 Starting daily absent marking cron job...');
    
    const today = new Date().toISOString().split('T')[0];
    const settings = await getAttendanceSettings();
    
    // Check if today is weekend or weekly off
    const todayDate = new Date(today);
    if (isWeekend(todayDate) || isWeeklyOff(todayDate, settings)) {
      console.log(`✅ Today (${today}) is weekend/weekly off - skipping absent marking`);
      
      if (res) {
        return res.json({ 
          success: true, 
          message: `Today (${today}) is weekend/weekly off - no absent marking needed` 
        });
      }
      return;
    }
    
    console.log(`📅 Processing absent marking for: ${today}`);
    
    // Get all active employees - using your actual table structure
    const [activeEmployees] = await conn.query(
      "SELECT id, employeeName FROM employees WHERE active = 1"
    );
    
    console.log(`👥 Found ${activeEmployees.length} active employees`);
    
    let markedAbsentCount = 0;
    let skippedCount = 0;
    
    // Process each employee
    for (const employee of activeEmployees) {
      // Check if attendance already exists for today
      const [existingAttendance] = await conn.query(
        "SELECT id FROM attendance WHERE employee_id = ? AND DATE(date) = ?",
        [employee.id, today]
      );
      
      if (existingAttendance.length === 0) {
        // No attendance record found - mark as absent with proper column names
        await conn.query(
          `INSERT INTO attendance 
           (employee_id, date, status, check_in, check_out, remarks, created_at, updated_at) 
           VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            employee.id, 
            today, 
            'Absent', 
            null,  // check_in
            null,  // check_out
            'Automatically marked as absent - no check-in recorded'
          ]
        );
        
        markedAbsentCount++;
        console.log(`❌ Marked absent: ${employee.employeeName} (ID: ${employee.id})`);
      } else {
        skippedCount++;
        console.log(`✅ Already has attendance: ${employee.employeeName}`);
      }
    }
    
    await conn.commit();
    
    const resultMessage = `Daily absent marking completed. Marked ${markedAbsentCount} employees as absent, ${skippedCount} already had attendance records.`;
    console.log(`✅ ${resultMessage}`);
    
    if (res) {
      return res.json({ 
        success: true, 
        message: resultMessage,
        data: {
          date: today,
          markedAbsent: markedAbsentCount,
          skipped: skippedCount,
          totalEmployees: activeEmployees.length
        }
      });
    }
    
    return resultMessage;
    
  } catch (error) {
    await conn.rollback();
    console.error('❌ Error in daily absent marking:', error);
    
    const errorMessage = `Error in daily absent marking: ${error.message}`;
    
    if (res) {
      return res.status(500).json({ 
        success: false, 
        message: errorMessage,
        error: error.message 
      });
    }
    
    throw error;
  } finally {
    conn.release();
  }
};

// ORIGINAL Backfill missing attendance records for a specific date range (UNCHANGED)
exports.backfillMissingAttendance = async (req, res = null) => {
   const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();
    
    let { startDate, endDate, month, year } = req?.body || req?.query || {};
    
    console.log('🎯 SPECIAL BACKFILL: Starting monthly backfill with alternative Saturdays (1st, 3rd, 5th)');
    console.log('📥 Parameters:', { startDate, endDate, month, year });

    // Handle different parameter formats
    if (!startDate || !endDate) {
      if (month && year) {
        // Use the provided month and year
        month = parseInt(month);
        year = parseInt(year);
        startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        endDate = `${year}-${month.toString().padStart(2, '0')}-${lastDay}`;
        
        console.log('📅 Using provided month/year:', { month, year, startDate, endDate });
      } else {
        // Default to current month
        const today = new Date();
        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
        const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        
        startDate = firstDay.toISOString().split('T')[0];
        endDate = lastDay.toISOString().split('T')[0];
        
        console.log('⚠️  No date provided, using current month:', { startDate, endDate });
      }
    }

    console.log(`🔄 SPECIAL BACKFILL: Processing from ${startDate} to ${endDate} with alternative Saturdays...`);
    
    const settings = await getAttendanceSettings();
    
    // USE TEMPORARY FUNCTION: Get working days including alternative Saturdays
    const workingDays = getWorkingDaysWithAlternativeSaturdays(startDate, endDate);
    
    console.log(`📅 Processing ${workingDays.length} working days (including alternative Saturdays)`);
    
    // Get all active employees
    const [activeEmployees] = await conn.query(
      "SELECT id, employeeName FROM employees WHERE active = 1"
    );
    
    console.log(`👥 Found ${activeEmployees.length} active employees`);
    
    let totalRecordsCreated = 0;
    let totalRecordsSkipped = 0;
    let saturdaysIncluded = 0;
    
    // Process each working day and each employee
    for (const date of workingDays) {
      const dateStr = date.toISOString().split('T')[0];
      const dayOfWeek = date.getDay();
      const isSaturday = dayOfWeek === 6;
      
      // For non-Saturday days, check weekly off settings
      if (!isSaturday && isWeeklyOff(date, settings)) {
        console.log(`⏭️  Skipping weekly off: ${dateStr}`);
        continue;
      }
      
      if (isSaturday) {
        saturdaysIncluded++;
        console.log(`🔧 Including alternative Saturday: ${dateStr}`);
      }
      
      for (const employee of activeEmployees) {
        // Check if attendance already exists for this date and employee
        const [existingAttendance] = await conn.query(
          "SELECT id FROM attendance WHERE employee_id = ? AND DATE(date) = ?",
          [employee.id, dateStr]
        );
        
        if (existingAttendance.length === 0) {
          // No attendance record found - mark as absent with proper column structure
          await conn.query(
            `INSERT INTO attendance 
             (employee_id, date, status, check_in, check_out, remarks, created_at, updated_at) 
             VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
              employee.id, 
              dateStr, 
              'Absent', 
              null,  // check_in
              null,  // check_out
              `Automatically marked as absent during special backfill process for ${dateStr}` + 
              (isSaturday ? ' (Alternative Saturday)' : '')
            ]
          );
          
          totalRecordsCreated++;
          if (totalRecordsCreated % 50 === 0) {
            console.log(`✅ Created ${totalRecordsCreated} records so far...`);
          }
        } else {
          totalRecordsSkipped++;
        }
      }
    }
    
    await conn.commit();
    
    const resultMessage = `SPECIAL BACKFILL COMPLETED. Created ${totalRecordsCreated} absent records, skipped ${totalRecordsSkipped} existing records for ${workingDays.length} working days (including ${saturdaysIncluded} alternative Saturdays).`;
    console.log(`✅ ${resultMessage}`);
    console.log('⚠️  NOTE: This was a one-time special backfill with alternative Saturdays');
    
    if (res) {
      return res.json({ 
        success: true, 
        message: resultMessage,
        data: {
          startDate,
          endDate,
          workingDaysProcessed: workingDays.length,
          recordsCreated: totalRecordsCreated,
          recordsSkipped: totalRecordsSkipped,
          totalEmployees: activeEmployees.length,
          alternativeSaturdaysIncluded: saturdaysIncluded,
          note: 'This was a one-time special backfill with alternative Saturdays (1st, 3rd, 5th)'
        }
      });
    }
    
    return resultMessage;
    
  } catch (error) {
    await conn.rollback();
    console.error('❌ Error in special backfill with alternative Saturdays:', error);
    
    const errorMessage = `Error in special backfill process: ${error.message}`;
    
    if (res) {
      return res.status(500).json({ 
        success: false, 
        message: errorMessage,
        error: error.message 
      });
    }
    
    throw error;
  } finally {
    conn.release();
  }
};


// NEW: Special backfill function with alternative Saturdays (FOR ONE-TIME USE ONLY)
exports.backfillMonthlyWithAlternativeSaturdays = async (req, res = null) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();
    
    let { startDate, endDate, month, year } = req?.body || req?.query || {};
    
    console.log('🎯 SPECIAL BACKFILL: Starting monthly backfill with alternative Saturdays (1st, 3rd, 5th)');
    console.log('📥 Parameters:', { startDate, endDate, month, year });

    // Handle different parameter formats
    if (!startDate || !endDate) {
      if (month && year) {
        // Use the provided month and year
        month = parseInt(month);
        year = parseInt(year);
        startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        endDate = `${year}-${month.toString().padStart(2, '0')}-${lastDay}`;
        
        console.log('📅 Using provided month/year:', { month, year, startDate, endDate });
      } else {
        // Default to current month
        const today = new Date();
        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
        const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        
        startDate = firstDay.toISOString().split('T')[0];
        endDate = lastDay.toISOString().split('T')[0];
        
        console.log('⚠️  No date provided, using current month:', { startDate, endDate });
      }
    }

    console.log(`🔄 SPECIAL BACKFILL: Processing from ${startDate} to ${endDate} with alternative Saturdays...`);
    
    const settings = await getAttendanceSettings();
    
    // USE TEMPORARY FUNCTION: Get working days including alternative Saturdays
    const workingDays = getWorkingDaysWithAlternativeSaturdays(startDate, endDate);
    
    console.log(`📅 Processing ${workingDays.length} working days (including alternative Saturdays)`);
    
    // Get all active employees
    const [activeEmployees] = await conn.query(
      "SELECT id, employeeName FROM employees WHERE active = 1"
    );
    
    console.log(`👥 Found ${activeEmployees.length} active employees`);
    
    let totalRecordsCreated = 0;
    let totalRecordsSkipped = 0;
    let saturdaysIncluded = 0;
    
    // Process each working day and each employee
    for (const date of workingDays) {
      const dateStr = date.toISOString().split('T')[0];
      const dayOfWeek = date.getDay();
      const isSaturday = dayOfWeek === 6;
      
      // For non-Saturday days, check weekly off settings
      if (!isSaturday && isWeeklyOff(date, settings)) {
        console.log(`⏭️  Skipping weekly off: ${dateStr}`);
        continue;
      }
      
      if (isSaturday) {
        saturdaysIncluded++;
        console.log(`🔧 Including alternative Saturday: ${dateStr}`);
      }
      
      for (const employee of activeEmployees) {
        // Check if attendance already exists for this date and employee
        const [existingAttendance] = await conn.query(
          "SELECT id FROM attendance WHERE employee_id = ? AND DATE(date) = ?",
          [employee.id, dateStr]
        );
        
        if (existingAttendance.length === 0) {
          // No attendance record found - mark as absent with proper column structure
          await conn.query(
            `INSERT INTO attendance 
             (employee_id, date, status, check_in, check_out, remarks, created_at, updated_at) 
             VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
              employee.id, 
              dateStr, 
              'Absent', 
              null,  // check_in
              null,  // check_out
              `Automatically marked as absent during special backfill process for ${dateStr}` + 
              (isSaturday ? ' (Alternative Saturday)' : '')
            ]
          );
          
          totalRecordsCreated++;
          if (totalRecordsCreated % 50 === 0) {
            console.log(`✅ Created ${totalRecordsCreated} records so far...`);
          }
        } else {
          totalRecordsSkipped++;
        }
      }
    }
    
    await conn.commit();
    
    const resultMessage = `SPECIAL BACKFILL COMPLETED. Created ${totalRecordsCreated} absent records, skipped ${totalRecordsSkipped} existing records for ${workingDays.length} working days (including ${saturdaysIncluded} alternative Saturdays).`;
    console.log(`✅ ${resultMessage}`);
    console.log('⚠️  NOTE: This was a one-time special backfill with alternative Saturdays');
    
    if (res) {
      return res.json({ 
        success: true, 
        message: resultMessage,
        data: {
          startDate,
          endDate,
          workingDaysProcessed: workingDays.length,
          recordsCreated: totalRecordsCreated,
          recordsSkipped: totalRecordsSkipped,
          totalEmployees: activeEmployees.length,
          alternativeSaturdaysIncluded: saturdaysIncluded,
          note: 'This was a one-time special backfill with alternative Saturdays (1st, 3rd, 5th)'
        }
      });
    }
    
    return resultMessage;
    
  } catch (error) {
    await conn.rollback();
    console.error('❌ Error in special backfill with alternative Saturdays:', error);
    
    const errorMessage = `Error in special backfill process: ${error.message}`;
    
    if (res) {
      return res.status(500).json({ 
        success: false, 
        message: errorMessage,
        error: error.message 
      });
    }
    
    throw error;
  } finally {
    conn.release();
  }
};

// Get missing attendance report
exports.getMissingAttendanceReport = async (req, res) => {
  try {
    const { startDate, endDate, month, year } = req.query;
    
    let dateRange = {};
    if (startDate && endDate) {
      dateRange.startDate = startDate;
      dateRange.endDate = endDate;
    } else if (month && year) {
      dateRange.startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      dateRange.endDate = `${year}-${month.toString().padStart(2, '0')}-${lastDay}`;
    } else {
      // Default to current month
      const today = new Date();
      dateRange.startDate = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-01`;
      dateRange.endDate = today.toISOString().split('T')[0];
    }
    
    const settings = await getAttendanceSettings();
    const weekdays = getWeekdaysBetweenDates(dateRange.startDate, dateRange.endDate);
    
    // Get all active employees
    const [activeEmployees] = await db.query(
      "SELECT id, employeeName, department FROM employees WHERE active = 1"
    );
    
    // Get existing attendance records for the date range
    const [existingAttendance] = await db.query(`
      SELECT employee_id, DATE(date) as attendance_date 
      FROM attendance 
      WHERE date BETWEEN ? AND ?
    `, [dateRange.startDate, dateRange.endDate]);
    
    // Create a set of existing attendance for quick lookup
    const existingAttendanceSet = new Set();
    existingAttendance.forEach(record => {
      existingAttendanceSet.add(`${record.employee_id}-${record.attendance_date}`);
    });
    
    // Calculate missing records
    const missingRecords = [];
    let totalMissing = 0;
    
    for (const employee of activeEmployees) {
      const employeeMissing = [];
      
      for (const date of weekdays) {
        const dateStr = date.toISOString().split('T')[0];
        
        // Skip weekly off days
        if (isWeeklyOff(date, settings)) continue;
        
        const attendanceKey = `${employee.id}-${dateStr}`;
        
        if (!existingAttendanceSet.has(attendanceKey)) {
          employeeMissing.push(dateStr);
          totalMissing++;
        }
      }
      
      if (employeeMissing.length > 0) {
        missingRecords.push({
          employeeId: employee.id,
          employeeName: employee.employeeName,
          department: employee.department,
          missingDates: employeeMissing,
          missingCount: employeeMissing.length
        });
      }
    }
    
    res.json({
      success: true,
      data: {
        dateRange,
        weekdaysCount: weekdays.length,
        activeEmployeesCount: activeEmployees.length,
        totalMissingRecords: totalMissing,
        missingRecords: missingRecords.sort((a, b) => b.missingCount - a.missingCount),
        summary: {
          byDepartment: missingRecords.reduce((acc, record) => {
            acc[record.department] = (acc[record.department] || 0) + record.missingCount;
            return acc;
          }, {})
        }
      }
    });
    
  } catch (error) {
    console.error('Error generating missing attendance report:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error generating missing attendance report',
      error: error.message 
    });
  }
};

// Manual trigger for testing - UPDATED to include special backfill
exports.manualTrigger = async (req, res) => {
  try {
    const { type, startDate, endDate, month, year } = req.body;
    
    let result;
    
    switch (type) {
      case 'daily':
        result = await exports.dailyAbsentMarking(req, res);
        break;
        
      case 'backfill':
        result = await exports.backfillMissingAttendance(req, res);
        break;
        
      case 'backfill-with-saturdays': // NEW: Special one-time backfill
        result = await exports.backfillMonthlyWithAlternativeSaturdays(req, res);
        break;
        
      case 'report':
        result = await exports.getMissingAttendanceReport(req, res);
        break;
        
      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid type. Use "daily", "backfill", "backfill-with-saturdays", or "report"'
        });
    }
    
    return result;
    
  } catch (error) {
    console.error('Error in manual trigger:', error);
    res.status(500).json({
      success: false,
      message: 'Error executing manual trigger',
      error: error.message
    });
  }
};