const cron = require('node-cron');
const NotificationService = require('./notificationService');
const db = require('../config/db');

class ReminderScheduler {
  constructor() {
    this.notificationService = new NotificationService();
    this.isRunning = false;
    this.checkinReminderTime = '8:55'; // Default fallback
    this.checkoutReminderTime = '17:55'; // Default fallback (5:55 PM in 24h format)
  }

  // Get attendance settings from database
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
      
      // Return default settings if none exist
      return {
        reminderTime: '8:55',
        enableDailyReminder: false,
        markPresentByDefault: false,
        workingHours: '08:00',
        weeklyOff: {
          sun: true, mon: false, tue: false, wed: false, 
          thu: false, fri: false, sat: false
        }
      };
    } catch (error) {
      console.error('Error fetching attendance settings:', error);
      return {
        reminderTime: '8:55',
        enableDailyReminder: false
      };
    }
  }

  // Parse time string to cron format
  parseTimeToCron(timeString) {
    try {
      // Handle different time formats: "8:55", "08:55", "8:55 AM", "08:55 AM"
      let time = timeString.trim().toUpperCase();
      
      // Remove AM/PM and any spaces
      time = time.replace(/\s*(AM|PM)/, '');
      
      const [hours, minutes] = time.split(':').map(part => part.trim());
      
      let hoursNum = parseInt(hours);
      const minutesNum = parseInt(minutes);
      
      // If time string had PM and it's not 12, add 12 hours
      if (timeString.toUpperCase().includes('PM') && hoursNum !== 12) {
        hoursNum += 12;
      }
      
      // If time string had AM and it's 12, set to 0
      if (timeString.toUpperCase().includes('AM') && hoursNum === 12) {
        hoursNum = 0;
      }
      
      // Validate hours and minutes
      if (isNaN(hoursNum) || isNaN(minutesNum) || hoursNum < 0 || hoursNum > 23 || minutesNum < 0 || minutesNum > 59) {
        console.warn(`Invalid time format: ${timeString}. Using default.`);
        return { minutes: 55, hours: 8 }; // Default to 8:55 AM
      }
      
      return { minutes: minutesNum, hours: hoursNum };
    } catch (error) {
      console.error('Error parsing time:', error);
      return { minutes: 55, hours: 8 }; // Default to 8:55 AM
    }
  }

  // Update reminder times from settings
  async updateReminderTimes() {
    try {
      const settings = await this.getAttendanceSettings();
      
      // Update check-in reminder time
      if (settings.reminderTime) {
        this.checkinReminderTime = settings.reminderTime;
        console.log(`Check-in reminder time set from settings: ${this.checkinReminderTime}`);
      } else {
        console.log('No reminder time in settings, using default: 8:55 AM');
        this.checkinReminderTime = '8:55';
      }
      
      // You can also add checkout reminder time to settings if needed
      // For now, checkout remains fixed at 5:55 PM
      this.checkoutReminderTime = '17:55';
      
    } catch (error) {
      console.error('Error updating reminder times:', error);
      // Keep default values on error
      this.checkinReminderTime = '8:55';
      this.checkoutReminderTime = '17:55';
    }
  }

  // Check if employee has checked in for today
  async hasCheckedInToday(employeeId) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const [attendance] = await db.query(
        `SELECT id FROM attendance 
         WHERE employee_id = ? AND DATE(date) = ? AND check_in IS NOT NULL`,
        [employeeId, today]
      );
      return attendance.length > 0;
    } catch (error) {
      console.error('Error checking attendance:', error);
      return false;
    }
  }

  // Check if employee has checked out for today
  async hasCheckedOutToday(employeeId) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const [attendance] = await db.query(
        `SELECT id FROM attendance 
         WHERE employee_id = ? AND DATE(date) = ? AND check_out IS NOT NULL`,
        [employeeId, today]
      );
      return attendance.length > 0;
    } catch (error) {
      console.error('Error checking attendance:', error);
      return false;
    }
  }

  // Get employees who haven't checked in
  async getEmployeesWithoutCheckin() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const [employees] = await db.query(`
        SELECT e.* 
        FROM employees e
        AND NOT EXISTS (
          SELECT 1 FROM attendance a 
          WHERE a.employee_id = e.id 
          AND DATE(a.date) = ? 
          AND a.check_in IS NOT NULL
        )
      `, [today]);

      return employees;
    } catch (error) {
      console.error('Error fetching employees without checkin:', error);
      return [];
    }
  }

  // Get employees who haven't checked out
  async getEmployeesWithoutCheckout() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const [employees] = await db.query(`
        SELECT e.* 
        FROM employees e
        AND EXISTS (
          SELECT 1 FROM attendance a 
          WHERE a.employee_id = e.id 
          AND DATE(a.date) = ? 
          AND a.check_in IS NOT NULL
          AND a.check_out IS NULL
        )
      `, [today]);

      return employees;
    } catch (error) {
      console.error('Error fetching employees without checkout:', error);
      return [];
    }
  }

  // Send check-in reminders
  async sendCheckinReminders() {
    try {
      console.log('Sending check-in reminders...');
      
      const employees = await this.getEmployeesWithoutCheckin();
      console.log(`Found ${employees.length} employees without check-in`);

      const results = [];
      
      for (const employee of employees) {
        try {
          const result = await this.notificationService.sendReminder(
            employee.id, 
            'checkin',
            `Dear ${employee.name}, please remember to check in for work. Check-in time is 9:00 AM.`
          );
          results.push({
            employeeId: employee.id,
            employeeName: employee.name,
            ...result
          });
        } catch (error) {
          console.error(`Failed to send check-in reminder to ${employee.name}:`, error);
          results.push({
            employeeId: employee.id,
            employeeName: employee.name,
            error: error.message
          });
        }
      }

      console.log('Check-in reminders completed:', results);
      return results;
    } catch (error) {
      console.error('Error in sendCheckinReminders:', error);
      throw error;
    }
  }

  // Send check-out reminders
  async sendCheckoutReminders() {
    try {
      console.log('Sending check-out reminders...');
      
      const employees = await this.getEmployeesWithoutCheckout();
      console.log(`Found ${employees.length} employees without check-out`);

      const results = [];
      
      for (const employee of employees) {
        try {
          const result = await this.notificationService.sendReminder(
            employee.id, 
            'checkout',
            `Dear ${employee.name}, please remember to check out. Check-out time is 6:00 PM.`
          );
          results.push({
            employeeId: employee.id,
            employeeName: employee.name,
            ...result
          });
        } catch (error) {
          console.error(`Failed to send check-out reminder to ${employee.name}:`, error);
          results.push({
            employeeId: employee.id,
            employeeName: employee.name,
            error: error.message
          });
        }
      }

      console.log('Check-out reminders completed:', results);
      return results;
    } catch (error) {
      console.error('Error in sendCheckoutReminders:', error);
      throw error;
    }
  }

  // Get current scheduler status
  getSchedulerStatus() {
    return {
      isRunning: this.isRunning,
      checkinReminderTime: this.checkinReminderTime,
      checkoutReminderTime: this.checkoutReminderTime,
      checkinCron: `${this.parseTimeToCron(this.checkinReminderTime).minutes} ${this.parseTimeToCron(this.checkinReminderTime).hours} * * *`,
      checkoutCron: `${this.parseTimeToCron(this.checkoutReminderTime).minutes} ${this.parseTimeToCron(this.checkoutReminderTime).hours} * * *`
    };
  }

  // Start the scheduler
  async start() {
    if (this.isRunning) {
      console.log('Scheduler is already running');
      return this.getSchedulerStatus();
    }

    console.log('Starting reminder scheduler...');

    // Update reminder times from settings
    await this.updateReminderTimes();

    // Parse times for cron
    const checkinTime = this.parseTimeToCron(this.checkinReminderTime);
    const checkoutTime = this.parseTimeToCron(this.checkoutReminderTime);

    console.log('Scheduled times:', {
      checkin: `${checkinTime.hours}:${checkinTime.minutes.toString().padStart(2, '0')}`,
      checkout: `${checkoutTime.hours}:${checkoutTime.minutes.toString().padStart(2, '0')}`
    });

    // Schedule check-in reminder
    cron.schedule(`${checkinTime.minutes} ${checkinTime.hours} * * *`, async () => {
      console.log(`Running check-in reminder job at ${checkinTime.hours}:${checkinTime.minutes.toString().padStart(2, '0')}`);
      try {
        await this.sendCheckinReminders();
      } catch (error) {
        console.error('Check-in reminder job failed:', error);
      }
    }, {
      timezone: "Asia/Kolkata"
    });

    // Schedule check-out reminder
    cron.schedule(`${checkoutTime.minutes} ${checkoutTime.hours} * * *`, async () => {
      console.log(`Running check-out reminder job at ${checkoutTime.hours}:${checkoutTime.minutes.toString().padStart(2, '0')}`);
      try {
        await this.sendCheckoutReminders();
      } catch (error) {
        console.error('Check-out reminder job failed:', error);
      }
    }, {
      timezone: "Asia/Kolkata"
    });

    this.isRunning = true;
    
    const status = this.getSchedulerStatus();
    console.log('Reminder scheduler started successfully:', status);
    
    return status;
  }

  // Restart scheduler (useful when settings change)
  async restart() {
    console.log('Restarting reminder scheduler...');
    this.stop();
    return await this.start();
  }

  // Stop the scheduler
  stop() {
    this.isRunning = false;
    // Note: node-cron doesn't have a direct way to stop individual jobs
    // In a real implementation, you might want to store cron job references
    console.log('Reminder scheduler stopped');
    return this.getSchedulerStatus();
  }
}

module.exports = ReminderScheduler;