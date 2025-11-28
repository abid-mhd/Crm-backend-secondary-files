const db = require("../config/db");
const { parseTimeToMinutes, formatMinutesToReadable, isWorkingDay } = require("../controllers/employeeController");

class ManualAbsentMarker {
  constructor() {
    this.workingHours = '09:00'; // Default working hours
  }

  // Check if a date is a working day
  isWorkingDay(date) {
    const dayOfWeek = date.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    return dayOfWeek >= 1 && dayOfWeek <= 5; // Monday to Friday
  }

  // Get attendance settings
  async getAttendanceSettings() {
    try {
      const [settings] = await db.query(`
        SELECT * FROM attendance_settings WHERE id = 1
      `);
      
      if (settings.length > 0) {
        const settingsData = typeof settings[0].settings_data === 'string' 
          ? JSON.parse(settings[0].settings_data) 
          : settings[0].settings_data;
        
        return settingsData;
      }
      
      return {
        workingHours: '09:00',
        weeklyOff: {
          sun: true, mon: false, tue: false, wed: false, 
          thu: false, fri: false, sat: true
        }
      };
    } catch (error) {
      console.error('Error fetching attendance settings:', error);
      return {
        workingHours: '09:00'
      };
    }
  }

  // Get employees who checked in but didn't check out for a specific date
  async getEmployeesWithoutCheckoutForDate(date) {
    try {
      const dateStr = date.toISOString().split('T')[0];
      const [employees] = await db.query(`
        SELECT e.*, a.check_in, a.id as attendance_id
        FROM employees e
        INNER JOIN attendance a ON e.id = a.employee_id
        WHERE e.active = 1 
        AND DATE(a.date) = ? 
        AND a.check_in IS NOT NULL
        AND a.check_out IS NULL
        AND a.status != 'Absent' -- Exclude already marked absent
      `, [dateStr]);

      return employees;
    } catch (error) {
      console.error(`Error fetching employees without checkout for ${date}:`, error);
      return [];
    }
  }

  // Mark employee as absent for specific date
  async markEmployeeAbsent(employeeId, date, checkinTime) {
    try {
      const dateStr = date.toISOString().split('T')[0];
      
      // Update attendance record to mark as absent
      const [result] = await db.query(`
        UPDATE attendance 
        SET status = 'Absent', 
            remarks = CONCAT(IFNULL(remarks, ''), ?),
            updated_at = NOW()
        WHERE employee_id = ? 
        AND DATE(date) = ? 
        AND check_out IS NULL
        AND status != 'Absent' 
      `, [
        ` | Auto-marked absent (manual cron): Checked in at ${checkinTime} but no checkout`,
        employeeId, 
        dateStr
      ]);
      
      if (result.affectedRows > 0) {
        console.log(`✅ Marked employee ${employeeId} as absent for ${dateStr} (checked in at ${checkinTime})`);
        return true;
      } else {
        console.log(`ℹ️ Employee ${employeeId} already marked as absent for ${dateStr} or record not found`);
        return false;
      }
    } catch (error) {
      console.error(`Error marking employee ${employeeId} as absent for ${dateStr}:`, error);
      return false;
    }
  }

  // Main function to process absent marking for date range
  async processAbsentMarkingForDateRange(startDate, endDate) {
    const connection = await db.getConnection();
    
    try {
      await connection.beginTransaction();
      
      console.log(`🚀 Starting manual absent marking from ${startDate} to ${endDate}...`);
      
      // Update working hours from settings
      const settings = await this.getAttendanceSettings();
      if (settings.workingHours) {
        this.workingHours = settings.workingHours;
        console.log(`✅ Using working hours: ${this.workingHours}`);
      }
      
      const start = new Date(startDate);
      const end = new Date(endDate);
      const results = {
        totalDatesProcessed: 0,
        totalRecordsUpdated: 0,
        totalRecordsSkipped: 0,
        dateWiseResults: []
      };
      
      // Process each date in the range
      for (let currentDate = new Date(start); currentDate <= end; currentDate.setDate(currentDate.getDate() + 1)) {
        const dateStr = currentDate.toISOString().split('T')[0];
        
        // Skip if not a working day
        if (!this.isWorkingDay(currentDate)) {
          console.log(`⏭️  Skipping non-working day: ${dateStr} (${currentDate.toLocaleDateString('en-US', { weekday: 'long' })})`);
          continue;
        }
        
        console.log(`\n📅 Processing date: ${dateStr} (${currentDate.toLocaleDateString('en-US', { weekday: 'long' })})`);
        
        // Get employees who checked in but didn't check out for this date
        const employeesWithoutCheckout = await this.getEmployeesWithoutCheckoutForDate(currentDate);
        
        console.log(`👥 Found ${employeesWithoutCheckout.length} employees without checkout for ${dateStr}`);
        
        let dateRecordsUpdated = 0;
        let dateRecordsSkipped = 0;
        
        for (const employee of employeesWithoutCheckout) {
          try {
            const absentMarked = await this.markEmployeeAbsent(
              employee.id, 
              currentDate, 
              employee.check_in
            );
            
            if (absentMarked) {
              dateRecordsUpdated++;
              results.totalRecordsUpdated++;
            } else {
              dateRecordsSkipped++;
              results.totalRecordsSkipped++;
            }
          } catch (error) {
            console.error(`❌ Failed to mark absent for ${employee.employeeName}:`, error);
            dateRecordsSkipped++;
            results.totalRecordsSkipped++;
          }
        }
        
        results.dateWiseResults.push({
          date: dateStr,
          employeesWithoutCheckout: employeesWithoutCheckout.length,
          recordsUpdated: dateRecordsUpdated,
          recordsSkipped: dateRecordsSkipped
        });
        
        results.totalDatesProcessed++;
        
        console.log(`✅ Completed ${dateStr}: ${dateRecordsUpdated} updated, ${dateRecordsSkipped} skipped`);
      }
      
      await connection.commit();
      
      console.log('\n🎉 Manual absent marking completed!');
      console.log('📊 Final Results:', {
        dateRange: `${startDate} to ${endDate}`,
        totalDatesProcessed: results.totalDatesProcessed,
        totalRecordsUpdated: results.totalRecordsUpdated,
        totalRecordsSkipped: results.totalRecordsSkipped,
        workingHoursUsed: this.workingHours
      });
      
      return results;
      
    } catch (error) {
      await connection.rollback();
      console.error('❌ Error in manual absent marking:', error);
      throw error;
    } finally {
      connection.release();
    }
  }
}

// Standalone function to run the manual absent marking
async function runManualAbsentMarking(startDate, endDate) {
  console.log('🚀 Starting standalone manual absent marking...');
  
  if (!startDate || !endDate) {
    console.error('❌ Error: Please provide both startDate and endDate (YYYY-MM-DD format)');
    console.log('💡 Usage: node cron/manualAbsentMarking.js 2024-11-01 2024-11-30');
    process.exit(1);
  }
  
  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
    console.error('❌ Error: Dates must be in YYYY-MM-DD format');
    process.exit(1);
  }
  
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    console.error('❌ Error: Invalid date format');
    process.exit(1);
  }
  
  if (start > end) {
    console.error('❌ Error: startDate cannot be after endDate');
    process.exit(1);
  }
  
  try {
    const marker = new ManualAbsentMarker();
    const results = await marker.processAbsentMarkingForDateRange(startDate, endDate);
    
    console.log('\n✅ Manual absent marking completed successfully!');
    console.log('📈 Summary:');
    console.log(`   Date Range: ${startDate} to ${endDate}`);
    console.log(`   Working Days Processed: ${results.totalDatesProcessed}`);
    console.log(`   Records Updated: ${results.totalRecordsUpdated}`);
    console.log(`   Records Skipped: ${results.totalRecordsSkipped}`);
    console.log(`   Working Hours Used: ${marker.workingHours}`);
    
    // Show date-wise breakdown
    console.log('\n📅 Date-wise Breakdown:');
    results.dateWiseResults.forEach(result => {
      console.log(`   ${result.date}: ${result.recordsUpdated} updated, ${result.recordsSkipped} skipped`);
    });
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Manual absent marking failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const startDate = args[0];
  const endDate = args[1];
  
  runManualAbsentMarking(startDate, endDate);
}

module.exports = {
  ManualAbsentMarker,
  runManualAbsentMarking
};