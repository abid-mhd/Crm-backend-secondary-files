const db = require("../config/db");

class ManualWeeklyOffManager {
  constructor() {
    this.weekOffDays = {
      sunday: true,    // All Sundays are weekly off
      saturday: '2nd,4th' // Only 2nd and 4th Saturdays are weekly off
    };
  }

  // Check if a date is 2nd or 4th Saturday
  isSecondOrFourthSaturday(date) {
    const day = date.getDay(); // 0 = Sunday, 6 = Saturday
    const dateOfMonth = date.getDate();
    
    if (day !== 6) return false; // Not Saturday
    
    // Calculate which week of the month (1st, 2nd, 3rd, 4th, 5th)
    const weekOfMonth = Math.ceil(dateOfMonth / 7);
    
    return weekOfMonth === 2 || weekOfMonth === 4; // 2nd or 4th Saturday
  }

  // Check if a date is Sunday
  isSunday(date) {
    return date.getDay() === 0;
  }

  // Check if date should be marked as weekly off based on company policy
  shouldBeWeeklyOff(date) {
    return this.isSunday(date) || this.isSecondOrFourthSaturday(date);
  }

  // Get week type for logging
  getWeekType(date) {
    const dateOfMonth = date.getDate();
    const weekOfMonth = Math.ceil(dateOfMonth / 7);
    
    if (this.isSunday(date)) return 'Sunday';
    if (this.isSecondOrFourthSaturday(date)) return `${weekOfMonth}nd Saturday`;
    
    return 'Working Day';
  }

  // Get all active employees
  async getActiveEmployees() {
    try {
      const [employees] = await db.query(`
        SELECT id, employeeName, employeeNo 
        FROM employees 
        WHERE active = 1
        ORDER BY id
      `);
      return employees;
    } catch (error) {
      console.error('Error fetching active employees:', error);
      return [];
    }
  }

  // Check if attendance record already exists for employee on specific date
  async attendanceRecordExists(employeeId, date) {
    try {
      const dateStr = date.toISOString().split('T')[0];
      const [records] = await db.query(`
        SELECT id, status 
        FROM attendance 
        WHERE employee_id = ? AND DATE(date) = ?
      `, [employeeId, dateStr]);
      
      return records.length > 0 ? records[0] : null;
    } catch (error) {
      console.error('Error checking attendance record:', error);
      return null;
    }
  }

  // Create weekly off record for employee
  async createWeeklyOffRecord(employeeId, date, weekType) {
    const connection = await db.getConnection();
    
    try {
      await connection.beginTransaction();
      
      const dateStr = date.toISOString().split('T')[0];
      
      // Insert weekly off record
      const [result] = await connection.query(`
        INSERT INTO attendance 
        (employee_id, date, status, check_in, check_out, remarks, created_at, updated_at) 
        VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
      `, [
        employeeId,
        dateStr,
        'Weekly Off',
        null,
        null,
        `Auto-created weekly off record (${weekType}) via manual cron`
      ]);
      
      await connection.commit();
      
      console.log(`✅ Created weekly off record for employee ${employeeId} on ${dateStr} (${weekType})`);
      return true;
      
    } catch (error) {
      await connection.rollback();
      console.error(`❌ Error creating weekly off record for employee ${employeeId} on ${date}:`, error);
      return false;
    } finally {
      connection.release();
    }
  }

  // Update existing record to weekly off status
  async updateToWeeklyOff(recordId, employeeId, date, weekType, currentStatus) {
    const connection = await db.getConnection();
    
    try {
      await connection.beginTransaction();
      
      const [result] = await connection.query(`
        UPDATE attendance 
        SET status = 'Weekly Off',
            remarks = CONCAT(IFNULL(remarks, ''), ?),
            updated_at = NOW()
        WHERE id = ?
      `, [
        ` | Updated to Weekly Off (${weekType}) via manual cron. Previous status: ${currentStatus}`,
        recordId
      ]);
      
      await connection.commit();
      
      console.log(`✅ Updated record ${recordId} to Weekly Off for employee ${employeeId} on ${date} (${weekType})`);
      return true;
      
    } catch (error) {
      await connection.rollback();
      console.error(`❌ Error updating record ${recordId} to weekly off:`, error);
      return false;
    } finally {
      connection.release();
    }
  }

  // Main function to process weekly off records for date range
  async processWeeklyOffForDateRange(startDate, endDate, options = {}) {
    const {
      createMissing = true,
      updateExisting = false,
      dryRun = false
    } = options;
    
    console.log(`🚀 Starting manual weekly off processing from ${startDate} to ${endDate}...`);
    console.log(`📋 Options:`, { createMissing, updateExisting, dryRun });
    
    if (dryRun) {
      console.log('🔍 DRY RUN MODE - No changes will be made to database');
    }
    
    // Get all active employees
    const activeEmployees = await this.getActiveEmployees();
    console.log(`👥 Found ${activeEmployees.length} active employees`);
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    const results = {
      totalDatesProcessed: 0,
      totalWeeklyOffDates: 0,
      recordsCreated: 0,
      recordsUpdated: 0,
      recordsSkipped: 0,
      employeesProcessed: activeEmployees.length,
      dateWiseResults: [],
      employeeWiseSummary: {}
    };
    
    // Initialize employee-wise summary
    activeEmployees.forEach(emp => {
      results.employeeWiseSummary[emp.id] = {
        employeeName: emp.employeeName,
        recordsCreated: 0,
        recordsUpdated: 0,
        recordsSkipped: 0
      };
    });
    
    // Process each date in the range
    for (let currentDate = new Date(start); currentDate <= end; currentDate.setDate(currentDate.getDate() + 1)) {
      const dateStr = currentDate.toISOString().split('T')[0];
      const weekType = this.getWeekType(currentDate);
      
      // Check if this date should be weekly off
      if (!this.shouldBeWeeklyOff(currentDate)) {
        console.log(`⏭️  Skipping working day: ${dateStr} (${weekType})`);
        continue;
      }
      
      console.log(`\n📅 Processing weekly off date: ${dateStr} (${weekType})`);
      
      let dateRecordsCreated = 0;
      let dateRecordsUpdated = 0;
      let dateRecordsSkipped = 0;
      
      // Process each employee for this weekly off date
      for (const employee of activeEmployees) {
        try {
          // Check if record already exists
          const existingRecord = await this.attendanceRecordExists(employee.id, currentDate);
          
          if (!existingRecord) {
            // No record exists - create new weekly off record
            if (createMissing && !dryRun) {
              const created = await this.createWeeklyOffRecord(employee.id, currentDate, weekType);
              if (created) {
                dateRecordsCreated++;
                results.recordsCreated++;
                results.employeeWiseSummary[employee.id].recordsCreated++;
              }
            } else {
              console.log(`📝 Would create weekly off record for ${employee.employeeName} on ${dateStr} (${weekType})`);
              dateRecordsSkipped++;
              results.recordsSkipped++;
              results.employeeWiseSummary[employee.id].recordsSkipped++;
            }
          } else {
            // Record exists - check if needs update
            if (existingRecord.status !== 'Weekly Off') {
              if (updateExisting && !dryRun) {
                const updated = await this.updateToWeeklyOff(
                  existingRecord.id, 
                  employee.id, 
                  dateStr, 
                  weekType, 
                  existingRecord.status
                );
                if (updated) {
                  dateRecordsUpdated++;
                  results.recordsUpdated++;
                  results.employeeWiseSummary[employee.id].recordsUpdated++;
                }
              } else {
                console.log(`📝 Would update record for ${employee.employeeName} on ${dateStr} from ${existingRecord.status} to Weekly Off`);
                dateRecordsSkipped++;
                results.recordsSkipped++;
                results.employeeWiseSummary[employee.id].recordsSkipped++;
              }
            } else {
              // Already weekly off - skip
              console.log(`⏭️  Record already exists as Weekly Off for ${employee.employeeName} on ${dateStr}`);
              dateRecordsSkipped++;
              results.recordsSkipped++;
              results.employeeWiseSummary[employee.id].recordsSkipped++;
            }
          }
        } catch (error) {
          console.error(`❌ Error processing employee ${employee.employeeName} for ${dateStr}:`, error);
          dateRecordsSkipped++;
          results.recordsSkipped++;
          results.employeeWiseSummary[employee.id].recordsSkipped++;
        }
      }
      
      results.dateWiseResults.push({
        date: dateStr,
        weekType: weekType,
        recordsCreated: dateRecordsCreated,
        recordsUpdated: dateRecordsUpdated,
        recordsSkipped: dateRecordsSkipped
      });
      
      results.totalWeeklyOffDates++;
      results.totalDatesProcessed++;
      
      console.log(`✅ Completed ${dateStr}: ${dateRecordsCreated} created, ${dateRecordsUpdated} updated, ${dateRecordsSkipped} skipped`);
    }
    
    console.log('\n🎉 Manual weekly off processing completed!');
    
    return results;
  }

  // Generate detailed report
  generateReport(results, startDate, endDate, options) {
    console.log('\n📊 ===== WEEKLY OFF PROCESSING REPORT =====');
    console.log(`📅 Date Range: ${startDate} to ${endDate}`);
    console.log(`👥 Employees Processed: ${results.employeesProcessed}`);
    console.log(`📅 Total Dates Processed: ${results.totalDatesProcessed}`);
    console.log(`🏖️  Weekly Off Dates Found: ${results.totalWeeklyOffDates}`);
    console.log(`✅ Records Created: ${results.recordsCreated}`);
    console.log(`🔄 Records Updated: ${results.recordsUpdated}`);
    console.log(`⏭️  Records Skipped: ${results.recordsSkipped}`);
    
    if (options.dryRun) {
      console.log('\n💡 NOTE: This was a DRY RUN - no changes were made to the database');
    }
    
    // Show date-wise summary
    console.log('\n📅 DATE-WISE SUMMARY:');
    results.dateWiseResults.forEach(result => {
      console.log(`   ${result.date} (${result.weekType}): ${result.recordsCreated} created, ${result.recordsUpdated} updated, ${result.recordsSkipped} skipped`);
    });
    
    // Show employee-wise summary (top 10)
    console.log('\n👥 EMPLOYEE-WISE SUMMARY (Top 10):');
    const employeeSummary = Object.values(results.employeeWiseSummary)
      .filter(emp => emp.recordsCreated > 0 || emp.recordsUpdated > 0)
      .sort((a, b) => (b.recordsCreated + b.recordsUpdated) - (a.recordsCreated + a.recordsUpdated))
      .slice(0, 10);
    
    employeeSummary.forEach(emp => {
      console.log(`   ${emp.employeeName}: ${emp.recordsCreated} created, ${emp.recordsUpdated} updated`);
    });
  }
}

// Standalone function to run the manual weekly off processing
async function runManualWeeklyOffProcessing(startDate, endDate, options = {}) {
  console.log('🚀 Starting standalone manual weekly off processing...');
  
  if (!startDate || !endDate) {
    console.error('❌ Error: Please provide both startDate and endDate (YYYY-MM-DD format)');
    console.log('💡 Usage: node cron/manualWeeklyOffRecords.js 2024-11-01 2024-11-30');
    console.log('💡 Optional flags: --dry-run --create-missing --update-existing');
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
    const manager = new ManualWeeklyOffManager();
    const results = await manager.processWeeklyOffForDateRange(startDate, endDate, options);
    
    manager.generateReport(results, startDate, endDate, options);
    
    if (!options.dryRun) {
      console.log('\n✅ Manual weekly off processing completed successfully!');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Manual weekly off processing failed:', error);
    process.exit(1);
  }
}

// Parse command line arguments
function parseCommandLineArgs() {
  const args = process.argv.slice(2);
  const options = {
    dryRun: false,
    createMissing: true,
    updateExisting: false
  };
  
  let startDate = null;
  let endDate = null;
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--create-missing') {
      options.createMissing = true;
    } else if (arg === '--no-create-missing') {
      options.createMissing = false;
    } else if (arg === '--update-existing') {
      options.updateExisting = true;
    } else if (arg === '--no-update-existing') {
      options.updateExisting = false;
    } else if (!startDate) {
      startDate = arg;
    } else if (!endDate) {
      endDate = arg;
    }
  }
  
  return { startDate, endDate, options };
}

// Run if called directly
if (require.main === module) {
  const { startDate, endDate, options } = parseCommandLineArgs();
  runManualWeeklyOffProcessing(startDate, endDate, options);
}

module.exports = {
  ManualWeeklyOffManager,
  runManualWeeklyOffProcessing
};