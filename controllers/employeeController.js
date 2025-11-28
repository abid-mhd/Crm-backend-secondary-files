const db = require('../config/db');
const createTransporter = require('../config/emailConfig');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const bcrypt = require("bcrypt");
const multer = require('multer');
const xlsx = require('xlsx');
const csv = require('csv-parser');
const stream = require('stream');
const NotificationService = require('../services/notificationService');
const twilio = require('twilio');
const cron = require('node-cron');

// Configure multer for file upload - FIXED VERSION
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Check file extension and MIME type more broadly
    const allowedExtensions = ['.xlsx', '.xls', '.csv'];
    const allowedMimeTypes = [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'application/csv',
      'application/octet-stream',
      'application/vnd.ms-excel.sheet.macroEnabled.12'
    ];

    const fileExtension = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));
    const isExtensionValid = allowedExtensions.includes(fileExtension);
    const isMimeTypeValid = allowedMimeTypes.includes(file.mimetype);

    console.log('File upload details:', {
      originalname: file.originalname,
      mimetype: file.mimetype,
      extension: fileExtension,
      isExtensionValid,
      isMimeTypeValid
    });

    if (isExtensionValid || isMimeTypeValid) {
      cb(null, true);
    } else {
      console.error('File upload rejected:', {
        originalname: file.originalname,
        mimetype: file.mimetype,
        extension: fileExtension
      });
      cb(new Error(`Please upload an Excel or CSV file. Allowed formats: ${allowedExtensions.join(', ')}`), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Initialize Twilio client only if in production
let twilioClient = null;
if (process.env.NODE_ENV === 'production' && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  console.log('✅ Twilio client initialized for production environment');
} else {
  console.log('ℹ️ Twilio notifications disabled - not in production environment');
}

// Utility functions for time calculations
const parseTimeToMinutes = (timeString) => {
  if (!timeString) return 9 * 60; // Default to 9 hours
  
  try {
    // Handle different formats: "09:30", "9:30", "9.5", 9.5
    if (typeof timeString === 'string') {
      if (timeString.includes(':')) {
        // HH:MM format
        const [hours, minutes] = timeString.split(':').map(Number);
        return (hours || 0) * 60 + (minutes || 0);
      } else {
        // Decimal format or number string
        const decimalValue = parseFloat(timeString);
        if (!isNaN(decimalValue)) {
          return Math.floor(decimalValue) * 60 + Math.round((decimalValue % 1) * 60);
        }
      }
    } else if (typeof timeString === 'number') {
      // Number format (assumed to be hours)
      return Math.floor(timeString) * 60 + Math.round((timeString % 1) * 60);
    }
  } catch (error) {
    console.error('Error parsing time:', error);
  }
  
  // Default fallback: 9 hours
  return 9 * 60;
};

const formatMinutesToTime = (totalMinutes) => {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
};

const formatMinutesToReadable = (totalMinutes) => {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  
  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h`;
  } else {
    return `${minutes}m`;
  }
};

// Calculate overtime hours based on check-in time and required checkout time
const calculateOvertime = (checkinTime, actualCheckoutTime, requiredCheckoutTime) => {
  try {
    if (!checkinTime || !actualCheckoutTime || !requiredCheckoutTime) {
      return { overtimeHours: 0, overtimeMinutes: 0 };
    }

    // Parse times to minutes
    const parseTime = (timeStr) => {
      const [hours, minutes] = timeStr.split(':').map(Number);
      return hours * 60 + minutes;
    };

    const checkinMinutes = parseTime(checkinTime);
    const actualCheckoutMinutes = parseTime(actualCheckoutTime);
    const requiredCheckoutMinutes = parseTime(requiredCheckoutTime);

    // Calculate total worked minutes
    const totalWorkedMinutes = actualCheckoutMinutes - checkinMinutes;
    
    // Calculate required working minutes
    const requiredWorkingMinutes = requiredCheckoutMinutes - checkinMinutes;
    
    // Calculate overtime (only if worked more than required)
    let overtimeMinutes = totalWorkedMinutes - requiredWorkingMinutes;
    
    // Only count overtime if it's positive and more than 15 minutes
    if (overtimeMinutes < 15) {
      return { overtimeHours: 0, overtimeMinutes: 0 };
    }

    // Convert to hours with 2 decimal places
    const overtimeHours = parseFloat((overtimeMinutes / 60).toFixed(2));

    return {
      overtimeHours: overtimeHours,
      overtimeMinutes: overtimeMinutes,
      overtimeFormatted: formatMinutesToReadable(overtimeMinutes)
    };
  } catch (error) {
    console.error('Error calculating overtime:', error);
    return { overtimeHours: 0, overtimeMinutes: 0 };
  }
};

// NEW: Utility function to check if today is a working day
const isWorkingDay = () => {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  
  // Only Monday (1) to Friday (5) are working days
  // Exclude Sunday (0) and Saturday (6)
  return dayOfWeek >= 1 && dayOfWeek <= 5;
};

class ReminderScheduler {
  constructor() {
    this.isRunning = false;
    this.checkinReminderTime = '8:55'; // Default fallback
    this.workingHours = '09:00'; // Default as string with minutes
    this.reminderBufferMinutes = 5; // 5 minutes before checkout
    this.absentCheckMinutes = 10; // 10 minutes after checkout to check for absence
    this.finalReminderMinutes = 120; // 120 minutes after checkout for final reminder
    this.endOfDayTime = '23:59'; // End of day for auto absent marking
    this.isProduction = process.env.NODE_ENV === 'production';
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
        workingHours: '09:00',
        weeklyOff: {
          sun: true, mon: false, tue: false, wed: false, 
          thu: false, fri: false, sat: true
        }
      };
    } catch (error) {
      console.error('Error fetching attendance settings:', error);
      return {
        reminderTime: '8:55',
        enableDailyReminder: false,
        workingHours: '09:00'
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

  // Convert working hours string to total minutes
  workingHoursToMinutes(workingHours) {
    return parseTimeToMinutes(workingHours);
  }

  // Format minutes to HH:MM string
  minutesToTimeString(totalMinutes) {
    try {
      let hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      
      // Handle overflow to next day
      if (hours >= 24) {
        hours -= 24;
      }
      
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    } catch (error) {
      console.error('Error formatting minutes to time:', error);
      return '19:00'; // Fallback
    }
  }

  // Calculate checkout time based on check-in time and working hours
  calculateCheckoutTime(checkinTime, workingHours = '09:00') {
    try {
      if (!checkinTime) {
        // Fallback to fixed checkout time if no check-in time
        const defaultWorkingMinutes = this.workingHoursToMinutes(workingHours);
        return this.minutesToTimeString(defaultWorkingMinutes);
      }

      // Parse check-in time
      const [checkinHours, checkinMinutes] = checkinTime.split(':').map(Number);
      const totalCheckinMinutes = checkinHours * 60 + checkinMinutes;
      
      // Convert working hours to minutes
      const workingMinutes = this.workingHoursToMinutes(workingHours);
      
      // Calculate checkout time
      const totalCheckoutMinutes = totalCheckinMinutes + workingMinutes;
      
      return this.minutesToTimeString(totalCheckoutMinutes);
    } catch (error) {
      console.error('Error calculating checkout time:', error);
      return '19:00'; // Fallback to 7:00 PM
    }
  }

  // Calculate reminder times based on checkout time
  calculateReminderTimes(checkoutTime) {
    try {
      const [checkoutHours, checkoutMinutes] = checkoutTime.split(':').map(Number);
      const totalCheckoutMinutes = checkoutHours * 60 + checkoutMinutes;
      
      // Reminder 5 minutes before checkout
      const reminderBeforeMinutes = totalCheckoutMinutes - this.reminderBufferMinutes;
      
      // Check for absence 10 minutes after checkout
      const absentCheckMinutes = totalCheckoutMinutes + this.absentCheckMinutes;
      
      // Final reminder 120 minutes after checkout
      const finalReminderMinutes = totalCheckoutMinutes + this.finalReminderMinutes;
      
      return {
        checkoutTime: checkoutTime,
        reminderBefore: this.minutesToTimeString(reminderBeforeMinutes),
        absentCheck: this.minutesToTimeString(absentCheckMinutes),
        finalReminder: this.minutesToTimeString(finalReminderMinutes)
      };
    } catch (error) {
      console.error('Error calculating reminder times:', error);
      return {
        checkoutTime: '19:00',
        reminderBefore: '18:55',
        absentCheck: '19:10',
        finalReminder: '21:00'
      };
    }
  }

  // Get employee's today check-in time
  async getEmployeeCheckinTime(employeeId) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const [attendance] = await db.query(`
        SELECT check_in FROM attendance 
        WHERE employee_id = ? AND DATE(date) = ? AND check_in IS NOT NULL
      `, [employeeId, today]);

      if (attendance.length > 0 && attendance[0].check_in) {
        return attendance[0].check_in;
      }
      return null;
    } catch (error) {
      console.error('Error getting employee check-in time:', error);
      return null;
    }
  }

  // NEW: Check if employee has already checked out today
  async hasEmployeeCheckedOut(employeeId) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const [attendance] = await db.query(`
        SELECT check_out FROM attendance 
        WHERE employee_id = ? AND DATE(date) = ? AND check_out IS NOT NULL
      `, [employeeId, today]);

      return attendance.length > 0 && attendance[0].check_out !== null;
    } catch (error) {
      console.error('Error checking employee checkout status:', error);
      return false;
    }
  }

  // Update reminder times from settings
  async updateReminderTimes() {
    try {
      const settings = await this.getAttendanceSettings();
      
      // Update check-in reminder time from settings
      if (settings.reminderTime && settings.reminderTime.trim() !== '') {
        this.checkinReminderTime = settings.reminderTime;
        console.log(`✅ Check-in reminder time set from settings: ${this.checkinReminderTime}`);
      } else {
        console.log('ℹ️ No reminder time in settings or empty value, using default: 8:55 AM');
        this.checkinReminderTime = '8:55';
      }
      
      // Update working hours from settings
      if (settings.workingHours) {
        this.workingHours = settings.workingHours;
        const workingMinutes = this.workingHoursToMinutes(this.workingHours);
        console.log(`✅ Working hours set from settings: ${this.workingHours} (${Math.floor(workingMinutes/60)}h ${workingMinutes%60}m)`);
      } else {
        this.workingHours = '09:00';
        console.log('ℹ️ No working hours in settings, using default: 09:00');
      }
      
      return {
        checkinReminderTime: this.checkinReminderTime,
        workingHours: this.workingHours,
        workingMinutes: this.workingHoursToMinutes(this.workingHours)
      };
      
    } catch (error) {
      console.error('Error updating reminder times:', error);
      // Keep default values on error
      this.checkinReminderTime = '8:55';
      this.workingHours = '09:00';
      return {
        checkinReminderTime: this.checkinReminderTime,
        workingHours: this.workingHours,
        workingMinutes: this.workingHoursToMinutes(this.workingHours)
      };
    }
  }

  // Send email reminder
  async sendEmailReminder(employee, reminderType, customMessage = null, checkoutTime = null) {
    try {
      const { employeeName, email, position, department, employeeNo } = employee;
      
      if (!email || email.trim() === '') {
        console.log(`No email address for ${employeeName}, skipping email`);
        return false;
      }

      let subject = '';
      let title = '';
      let action = '';
      let time = '';

      if (reminderType === 'checkin') {
        subject = 'Check-in Reminder - Icebergs India';
        title = 'Check-in Reminder';
        action = 'check in';
        time = '10:00 AM';
      } else if (reminderType === 'checkout_before') {
        subject = 'Check-out Reminder - Icebergs India';
        title = 'Check-out Reminder';
        action = 'check out';
        time = checkoutTime || '6:55 PM';
      } else if (reminderType === 'checkout_overdue') {
        subject = 'URGENT: Check-out Time Over - Icebergs India';
        title = 'Check-out Time Overdue';
        action = 'check out immediately';
        time = checkoutTime || '7:10 PM';
      } else if (reminderType === 'checkout_final') {
        subject = 'FINAL: Attendance Status Alert - Icebergs India';
        title = 'Final Attendance Alert';
        action = 'contact HR';
        time = checkoutTime || '9:00 PM';
      } else if (reminderType === 'auto_absent_warning') {
        subject = 'IMPORTANT: Auto Absent Warning - Icebergs India';
        title = 'Auto Absent Warning';
        action = 'check out immediately';
        time = 'End of Day';
      }

      // Create staff portal link
      const staffPortalLink = process.env.FRONTEND_URL || 'http://16.16.110.203';
      const loginLink = `${staffPortalLink}/login`;

      // Email HTML with professional styling
      const emailHtml = `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title>${title}</title>
      </head>
      <body style="font-family: Arial, sans-serif; background: #f7f7fb; margin: 0; padding: 0;">
        <div style="max-width: 600px; margin: 30px auto; background: #fff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
          
          <!-- Logo Section -->
          <div style="text-align: center; margin-bottom: 30px;">
            <img src="https://icebergsindia.com/wp-content/uploads/2020/01/4a4f2132b7-IMG_3970-1-e1743063706285.png" 
                 alt="Icebergs India Logo" 
                 style="max-width: 250px; height: auto;" />
          </div>

          <!-- Title -->
          <h2 style="color: #091D78; margin-bottom: 20px; text-align: center; font-size: 24px;">
            ${title}
          </h2>

          <!-- Welcome Message -->
          <p style="font-size: 15px; color: #555; line-height: 1.6; margin-bottom: 20px;">
            Hi <strong>${employeeName}</strong>,
          </p>
          
          <p style="font-size: 15px; color: #555; line-height: 1.6; margin-bottom: 25px;">
            ${customMessage || `This is a friendly reminder to ${action} for work today. Please remember to ${action} by ${time}.`}
          </p>

          <!-- Reminder Details Box -->
          <div style="background: #f8fafc; border: 2px solid #091D78; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
            <h3 style="font-size: 18px; font-weight: 600; color: #091D78; margin: 0 0 15px 0; text-align: center;">
              Reminder Details
            </h3>
            
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0;">
                  <strong style="color: #374151;">Employee Name:</strong>
                </td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; text-align: right;">
                  <span style="color: #111827;">${employeeName}</span>
                </td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0;">
                  <strong style="color: #374151;">Employee ID:</strong>
                </td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; text-align: right;">
                  <span style="color: #111827;">${employeeNo}</span>
                </td>
              </tr>
              <tr>
                <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0;">
                  <strong style="color: #374151;">Position:</strong>
                </td>
                <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; text-align: right;">
                  <span style="color: #111827;">${position}</span>
                </td>
              </tr>
              <tr>
                <td style="padding: 10px 0;">
                  <strong style="color: #374151;">Reminder Type:</strong>
                </td>
                <td style="padding: 10px 0; text-align: right;">
                  <span style="color: #111827; text-transform: capitalize;">${action}</span>
                </td>
              </tr>
            </table>
          </div>

          <!-- Action Button -->
          <div style="text-align: center; margin: 30px 0;">
            <a href="${loginLink}" 
               style="display: inline-block; background: #091D78; color: #fff; padding: 14px 40px; 
                      border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 16px;">
              Go to Staff Portal
            </a>
          </div>

          <!-- Important Note -->
          <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 15px; margin-bottom: 20px;">
            <p style="margin: 0; color: #856404; font-size: 14px; line-height: 1.5;">
              <strong>⏰ Important:</strong> Please ensure you ${action} on time to maintain accurate attendance records.
            </p>
          </div>

          <!-- Footer -->
          <div style="border-top: 2px solid #e2e8f0; padding-top: 20px; margin-top: 30px;">
            <p style="font-size: 14px; color: #555; line-height: 1.6; margin: 0;">
              If you have already ${action}ed, please ignore this reminder.
            </p>
            <p style="font-size: 14px; color: #555; margin: 15px 0 0 0;">
              <strong>Best regards,</strong><br/>
              The Icebergs HR Team
            </p>
          </div>

          <!-- Contact Info -->
          <div style="text-align: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
            <p style="font-size: 12px; color: #888; margin: 5px 0;">
              <a href="https://icebergsindia.com" style="color: #091D78; text-decoration: none;">www.icebergsindia.com</a>
            </p>
            <p style="font-size: 12px; color: #888; margin: 5px 0;">
              ${process.env.EMAIL_USER || 'garan6104@gmail.com'}
            </p>
          </div>

        </div>
      </body>
      </html>`;

      // Plain text version
      const textVersion = `
${title}

Hi ${employeeName},

${customMessage || `This is a friendly reminder to ${action} for work today. Please remember to ${action} by ${time}.`}

Reminder Details:
----------------
Employee Name: ${employeeName}
Employee ID: ${employeeNo}
Position: ${position}
Reminder Type: ${action}

Staff Portal: ${loginLink}

⏰ Important: Please ensure you ${action} on time to maintain accurate attendance records.

If you have already ${action}ed, please ignore this reminder.

Best regards,
The Icebergs HR Team

www.icebergsindia.com
${process.env.EMAIL_USER || 'garan6104@gmail.com'}
      `;

      // Create Gmail transporter directly
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      // Email options
      const mailOptions = {
        from: `"Icebergs India - HR Department" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: subject,
        html: emailHtml,
        text: textVersion
      };

      // Send email
      const info = await transporter.sendMail(mailOptions);

      console.log(`✅ ${title} email sent successfully to ${email}`);
      console.log('Message ID:', info.messageId);
      
      return true;

    } catch (error) {
      console.error(`❌ Error sending email reminder to ${employee.employeeName}:`, error);
      
      if (error.code === 'EAUTH') {
        console.error('Email authentication failed. Please check your Gmail credentials in .env file');
      } else if (error.code === 'ECONNECTION' || error.code === 'ETIMEDOUT') {
        console.error('Cannot connect to Gmail server. Please check your internet connection.');
      } else if (error.responseCode === 535) {
        console.error('Invalid Gmail credentials. Please verify EMAIL_USER and EMAIL_PASS in .env');
      }
      
      return false;
    }
  }

  async sendReminder(employeeId, reminderType, customMessage = null, checkoutTime = null) {
    try {
      // Get employee details with user ID and phone
      const [employees] = await db.query(`
        SELECT e.*, u.id as user_id 
        FROM employees e 
        LEFT JOIN users u ON e.id = u.employee_id 
        WHERE e.id = ? AND e.active = 1
      `, [employeeId]);

      if (employees.length === 0) {
        console.log('Employee not found:', employeeId);
        return;
      }

      const employee = employees[0];
      
      // NEW: For checkout reminders, check if employee has already checked out
      if (reminderType.includes('checkout')) {
        const hasCheckedOut = await this.hasEmployeeCheckedOut(employeeId);
        if (hasCheckedOut) {
          console.log(`⏭️  Skipping ${reminderType} reminder for ${employee.employeeName} - already checked out`);
          return {
            skipped: true,
            reason: 'already_checked_out',
            employeeName: employee.employeeName,
            reminderType: reminderType
          };
        }
      }
      
      let title = '';
      let message = '';

      if (reminderType === 'checkin') {
        title = 'Check-in Reminder';
        message = customMessage || `Dear ${employee.employeeName}, please remember to check in for work. Check-in time is 10:00 AM.`;
      } else if (reminderType === 'checkout_before') {
        title = 'Check-out Reminder';
        const workingMinutes = this.workingHoursToMinutes(this.workingHours);
        const workingHoursReadable = formatMinutesToReadable(workingMinutes);
        message = customMessage || `Dear ${employee.employeeName}, please remember to check out. Your calculated checkout time is ${checkoutTime} (based on ${workingHoursReadable} working hours).`;
      } else if (reminderType === 'checkout_overdue') {
        title = 'Check-out Time Overdue';
        message = customMessage || `Dear ${employee.employeeName}, your checkout time (${checkoutTime}) has passed. Please check out immediately to avoid being marked absent.`;
      } else if (reminderType === 'checkout_final') {
        title = 'Final Attendance Alert';
        message = customMessage || `Dear ${employee.employeeName}, you have not checked out. Today will be marked as absent unless you contact HR for approval.`;
      } else if (reminderType === 'auto_absent_warning') {
        title = 'Auto Absent Warning';
        message = customMessage || `Dear ${employee.employeeName}, you have not checked out today. If you don't check out by end of day (11:59 PM), you will be automatically marked as absent.`;
      }

      // Validate message is not empty
      if (!message || message.trim() === '') {
        console.error('Error: Message cannot be empty for employee:', employeeId);
        message = `Reminder: Please ${reminderType === 'checkin' ? 'check in' : 'check out'} for work today.`;
      }

      console.log(`📱 Preparing to send ${reminderType} reminder to ${employee.employeeName}:`, {
        phone: employee.phone,
        email: employee.email,
        message: message,
        environment: this.isProduction ? 'production' : 'development/staging',
        smsEnabled: this.isProduction
      });

      const results = {
        panelNotification: false,
        smsSent: false,
        emailSent: false,
        employeeName: employee.employeeName,
        phone: employee.phone,
        email: employee.email,
        environment: this.isProduction ? 'production' : 'development/staging'
      };

      // Send panel notification if user exists
      if (employee.user_id) {
        try {
          await NotificationService.createNotification({
            userIds: [employee.user_id],
            title: title,
            message: message,
            type: 'attendance',
            module: 'attendance'
          });
          console.log(`✅ Panel notification sent to user ${employee.user_id}`);
          results.panelNotification = true;
        } catch (notificationError) {
          console.error('Error sending panel notification:', notificationError);
        }
      }

      // Send SMS only in production environment
      if (this.isProduction && employee.phone && employee.phone.trim() !== '') {
        try {
          // Clean phone number - remove any non-digit characters except +
          const cleanPhone = employee.phone.replace(/[^\d+]/g, '');
          
          // Validate phone number format (basic validation)
          if (cleanPhone.length >= 10) {
            const smsResult = await this.sendSMS(cleanPhone, message);
            if (smsResult) {
              console.log(`✅ SMS sent successfully to ${employee.employeeName} (${cleanPhone})`);
              results.smsSent = true;
            } else {
              console.log(`❌ SMS failed for ${employee.employeeName} (${cleanPhone})`);
            }
          } else {
            console.log(`⚠️ Invalid phone number for ${employee.employeeName}: ${employee.phone}`);
          }
        } catch (smsError) {
          console.error(`❌ SMS error for ${employee.employeeName}:`, smsError.message);
        }
      } else {
        if (!this.isProduction) {
          console.log(`ℹ️ SMS skipped for ${employee.employeeName} - not in production environment`);
        } else {
          console.log(`ℹ️ No phone number available for ${employee.employeeName}`);
        }
      }

      // Send email reminder
      if (employee.email && employee.email.trim() !== '') {
        try {
          const emailSent = await this.sendEmailReminder(employee, reminderType, customMessage, checkoutTime);
          results.emailSent = emailSent;
          if (emailSent) {
            console.log(`✅ Email reminder sent successfully to ${employee.employeeName} (${employee.email})`);
          } else {
            console.log(`❌ Email failed for ${employee.employeeName} (${employee.email})`);
          }
        } catch (emailError) {
          console.error(`❌ Email error for ${employee.employeeName}:`, emailError.message);
        }
      } else {
        console.log(`ℹ️ No email address available for ${employee.employeeName}`);
      }

      console.log(`✅ Reminder processed for employee ${employeeId}: ${reminderType}`, results);
      
      return results;
    } catch (error) {
      console.error('Error sending reminder:', error);
      throw error;
    }
  }

  async sendSMS(to, message) {
    try {
      // Only send SMS in production environment
      if (!this.isProduction) {
        console.log(`ℹ️ SMS skipped - not in production environment (NODE_ENV: ${process.env.NODE_ENV})`);
        return { skipped: true, reason: 'not_production' };
      }

      if (!twilioClient) {
        console.log('Twilio not configured, skipping SMS');
        return null;
      }

      // Validate message is not empty
      if (!message || message.trim() === '') {
        console.error('Error: Cannot send empty SMS message');
        return null;
      }

      // Validate phone number
      if (!to || to.trim() === '') {
        console.error('Error: Cannot send SMS to empty phone number');
        return null;
      }

      // Use the same phone sanitization as your OTP code
      const sanitizePhone = (phone) => phone.replace(/\D/g, "");
      const sanitizedPhone = sanitizePhone(to);
      
      // Format phone number exactly like your OTP code
      const formattedPhone = `+91${sanitizedPhone}`;

      console.log(`📤 Sending SMS to ${formattedPhone}:`, message.substring(0, 50) + '...');

      // OPTION 1: Try using Messaging Service SID if you have one
      // This bypasses the phone number issue for Indian numbers
      let attempts = 0;
      let success = false;
      let result = null;

      while (!success && attempts < 2) {
        try {
          const messageOptions = {
            body: message,
            to: formattedPhone
          };

          // Try using Messaging Service SID first (if available)
          if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
            messageOptions.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
          } else if (process.env.TWILIO_PHONE_NUMBER) {
            // Fallback to phone number (may not work for India to India)
            messageOptions.from = process.env.TWILIO_PHONE_NUMBER;
          } else {
            throw new Error('Neither TWILIO_MESSAGING_SERVICE_SID nor TWILIO_PHONE_NUMBER is configured');
          }

          result = await twilioClient.messages.create(messageOptions);
          success = true;
        } catch (err) {
          attempts++;
          console.error(`Twilio SMS attempt ${attempts} failed:`, err.message);
          
          // If error is due to India restrictions, log specific message
          if (err.code === 21659) {
            console.error('⚠️ Indian phone number restrictions detected. Consider:');
            console.error('   1. Using a US/Canadian Twilio number');
            console.error('   2. Setting up a Messaging Service');
            console.error('   3. Using Twilio Verify Service instead');
          }
          
          if (attempts >= 2) throw err;
        }
      }

      console.log('✅ SMS sent successfully:', result.sid);
      console.log('📊 SMS Status:', result.status);
      
      return result;
    } catch (error) {
      console.error('❌ Error sending SMS:', error.message);
      console.error('📞 Phone number attempted:', to);
      console.error('🔧 Error code:', error.code);
      
      // More specific error handling
      if (error.code === 21659) {
        console.error('❌ Country/Region mismatch - Indian numbers cannot send to Indian numbers via standard SMS');
        console.error('💡 Solution: Use Twilio Verify Service or get a non-Indian Twilio number');
      } else if (error.code === 21211) {
        console.error('❌ Invalid phone number format');
      } else if (error.code === 21408) {
        console.error('❌ Permission denied - check Twilio permissions');
      } else if (error.code === 21610) {
        console.error('❌ Phone number not SMS capable');
      } else if (error.code === 21614) {
        console.error('❌ Phone number is not a valid mobile number');
      }
      
      return null;
    }
  }

  // Get employees who haven't checked in
  async getEmployeesWithoutCheckin() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const [employees] = await db.query(`
        SELECT e.* 
        FROM employees e
        WHERE e.active = 1 
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

  // Get employees who haven't checked out with their check-in times
  async getEmployeesWithoutCheckout() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const [employees] = await db.query(`
        SELECT e.*, a.check_in, a.id as attendance_id
        FROM employees e
        INNER JOIN attendance a ON e.id = a.employee_id
        WHERE e.active = 1 
        AND DATE(a.date) = ? 
        AND a.check_in IS NOT NULL
        AND a.check_out IS NULL
        AND a.status != 'Absent' -- Exclude already marked absent
      `, [today]);

      return employees;
    } catch (error) {
      console.error('Error fetching employees without checkout:', error);
      return [];
    }
  }

  // Send check-in reminders ONLY on working days
  async sendCheckinReminders() {
    try {
      // NEW: Check if today is a working day
      if (!isWorkingDay()) {
        console.log('📅 Today is not a working day. Skipping check-in reminders.');
        return {
          skipped: true,
          reason: 'not_working_day',
          message: 'Check-in reminders are only sent on working days'
        };
      }

      console.log('Sending check-in reminders...');
      
      const employees = await this.getEmployeesWithoutCheckin();
      console.log(`Found ${employees.length} employees without check-in`);

      const results = [];
      
      for (const employee of employees) {
        try {
          const result = await this.sendReminder(
            employee.id, 
            'checkin',
            `Dear ${employee.employeeName}, please remember to check in for work. Check-in time is 10:00 AM.`
          );
          results.push({
            employeeId: employee.id,
            employeeName: employee.employeeName,
            ...result
          });
        } catch (error) {
          console.error(`Failed to send check-in reminder to ${employee.employeeName}:`, error);
          results.push({
            employeeId: employee.id,
            employeeName: employee.employeeName,
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

  // Send dynamic checkout reminders based on individual check-in times
  async sendDynamicCheckoutReminders() {
    try {
      console.log('🕒 Sending dynamic checkout reminders...');
      const currentTime = new Date();
      console.log('📊 Current server time:', currentTime.toLocaleTimeString('en-IN', { 
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }));
      
      const employees = await this.getEmployeesWithoutCheckout();
      console.log(`👥 Found ${employees.length} employees without check-out`);

      if (employees.length === 0) {
        console.log('ℹ️ No employees found without checkout');
        return [];
      }

      const results = [];
      const today = new Date().toISOString().split('T')[0];
      
      for (const employee of employees) {
        try {
          // Check if employee is already marked as absent for today
          const [attendanceRecords] = await db.query(`
            SELECT status FROM attendance 
            WHERE employee_id = ? AND DATE(date) = ? AND status = 'Absent'
          `, [employee.id, today]);

          if (attendanceRecords.length > 0) {
            console.log(`⏭️  Skipping ${employee.employeeName} - already marked as absent for today`);
            continue; // Skip this employee
          }

          // Check if final reminder was already sent today
          const [existingFinalReminders] = await db.query(`
            SELECT id FROM notifications 
            WHERE user_id IN (SELECT id FROM users WHERE employee_id = ?)
            AND type = 'attendance'
            AND title LIKE '%Final Attendance Alert%'
            AND DATE(created_at) = ?
            LIMIT 1
          `, [employee.id, today]);

          const finalReminderAlreadySent = existingFinalReminders.length > 0;

          // Calculate checkout time based on check-in time and working hours
          const checkoutTime = this.calculateCheckoutTime(employee.check_in, this.workingHours);
          const reminderTimes = this.calculateReminderTimes(checkoutTime);
          
          const currentTime = new Date();
          const currentHours = currentTime.getHours();
          const currentMinutes = currentTime.getMinutes();
          const totalCurrentMinutes = currentHours * 60 + currentMinutes;
          
          const [checkoutHours, checkoutMinutes] = checkoutTime.split(':').map(Number);
          const totalCheckoutMinutes = checkoutHours * 60 + checkoutMinutes;
          
          // Calculate time differences
          const timeDiff = totalCheckoutMinutes - totalCurrentMinutes;
          const timeSinceCheckout = -timeDiff; // Positive if after checkout time
          
          console.log(`\n🔍 Processing employee: ${employee.employeeName}`);
          console.log(`   Check-in: ${employee.check_in}`);
          console.log(`   Working Hours: ${this.workingHours}`);
          console.log(`   Calculated Checkout: ${checkoutTime}`);
          console.log(`   Current Time: ${currentHours}:${currentMinutes.toString().padStart(2, '0')}`);
          console.log(`   Time Difference: ${timeDiff} minutes (${timeDiff > 0 ? 'before' : 'after'} checkout)`);
          console.log(`   Time Since Checkout: ${timeSinceCheckout} minutes`);
          console.log(`   Final Reminder Already Sent: ${finalReminderAlreadySent}`);
          console.log(`   Reminder Times:`, reminderTimes);
          
          let reminderType = null;
          let customMessage = '';
          let shouldSendReminder = false;
          
          // FINAL REMINDER: 10 minutes after checkout (ONLY ONCE)
          if (timeSinceCheckout >= 10 && timeSinceCheckout < 120 && !finalReminderAlreadySent) {
            reminderType = 'checkout_final';
            customMessage = `Dear ${employee.employeeName}, you have not checked out yet. Today will be marked as absent at the end of the day (11:59 PM) if you don't check out. This is your final reminder.`;
            shouldSendReminder = true;
            
            console.log(`   ⚠️  Sending FINAL reminder (${timeSinceCheckout} minutes after checkout)`);
            
          } 
          // OVERDUE REMINDER: 10 minutes after checkout (if final reminder not sent yet)
          else if (timeSinceCheckout >= 10 && timeSinceCheckout < 120 && finalReminderAlreadySent) {
            console.log(`   ℹ️  Final reminder already sent to ${employee.employeeName}, skipping additional reminders`);
            continue;
          }
          // BEFORE CHECKOUT REMINDER: 5 minutes before checkout
          else if (timeDiff <= this.reminderBufferMinutes && timeDiff > 0) {
            reminderType = 'checkout_before';
            const workingMinutes = this.workingHoursToMinutes(this.workingHours);
            const workingHoursReadable = formatMinutesToReadable(workingMinutes);
            customMessage = `Dear ${employee.employeeName}, please remember to check out. Your calculated checkout time is ${checkoutTime} (based on ${workingHoursReadable} working hours). You have ${timeDiff} minutes remaining.`;
            shouldSendReminder = true;
            
            console.log(`   🔔 Sending BEFORE checkout reminder (${timeDiff} minutes before checkout)`);
          } else {
            console.log(`   ℹ️  No reminder needed yet:`);
            if (timeDiff > this.reminderBufferMinutes) {
              console.log(`      Too early for reminder (${timeDiff} minutes before checkout)`);
            } else if (timeSinceCheckout < 10) {
              console.log(`      Just checked out recently (${timeSinceCheckout} minutes ago)`);
            } else if (timeSinceCheckout >= 120) {
              console.log(`      Already past final reminder window (${timeSinceCheckout} minutes ago)`);
            } else if (finalReminderAlreadySent) {
              console.log(`      Final reminder already sent (${timeSinceCheckout} minutes after checkout)`);
            }
            continue;
          }
          
          if (shouldSendReminder && reminderType) {
            console.log(`   📤 Sending ${reminderType} reminder...`);
            
            const result = await this.sendReminder(
              employee.id, 
              reminderType,
              customMessage,
              checkoutTime
            );
            
            // Check if reminder was skipped due to already checked out
            if (result && result.skipped) {
              console.log(`   ⏭️  Reminder skipped: ${result.reason}`);
              results.push({
                employeeId: employee.id,
                employeeName: employee.employeeName,
                reminderType: reminderType,
                reminderSent: false,
                skipped: true,
                reason: result.reason
              });
            } else {
              results.push({
                employeeId: employee.id,
                employeeName: employee.employeeName,
                checkinTime: employee.check_in,
                workingHours: this.workingHours,
                workingHoursReadable: formatMinutesToReadable(this.workingHoursToMinutes(this.workingHours)),
                checkoutTime: checkoutTime,
                reminderType: reminderType,
                timeDifference: timeDiff,
                timeSinceCheckout: timeSinceCheckout,
                finalReminderAlreadySent: finalReminderAlreadySent,
                reminderSent: true,
                ...result
              });
              
              console.log(`   ✅ ${reminderType} reminder sent successfully`);
            }
          }
          
        } catch (error) {
          console.error(`❌ Failed to process checkout reminder for ${employee.employeeName}:`, error);
          results.push({
            employeeId: employee.id,
            employeeName: employee.employeeName,
            error: error.message,
            reminderSent: false
          });
        }
      }

      console.log('✅ Dynamic checkout reminders completed. Results:', {
        totalProcessed: employees.length,
        remindersSent: results.filter(r => r.reminderSent).length,
        remindersSkipped: results.filter(r => r.skipped).length,
        details: results.map(r => ({
          employee: r.employeeName,
          type: r.reminderType,
          sent: r.reminderSent,
          skipped: r.skipped || false,
          reason: r.reason || 'None',
          finalReminderAlreadySent: r.finalReminderAlreadySent,
          error: r.error || 'None'
        }))
      });
      
      return results;
    } catch (error) {
      console.error('❌ Error in sendDynamicCheckoutReminders:', error);
      throw error;
    }
  }

  // NEW: Auto mark absent at end of day for employees who checked in but didn't check out
  async autoMarkAbsentAtEndOfDay() {
    try {
      console.log('🌙 Running end-of-day auto absent marking...');
      const today = new Date().toISOString().split('T')[0];
      
      // Get employees who checked in today but didn't check out
      const employeesWithoutCheckout = await this.getEmployeesWithoutCheckout();
      console.log(`👥 Found ${employeesWithoutCheckout.length} employees without checkout for today`);
      
      const results = [];
      
      for (const employee of employeesWithoutCheckout) {
        try {
          console.log(`🔍 Processing employee: ${employee.employeeName} (ID: ${employee.id})`);
          
          // Mark as absent
          const absentMarked = await this.markEmployeeAbsent(employee.id);
          
          if (absentMarked) {
            // Send notification about auto absent marking
            await this.sendReminder(
              employee.id,
              'auto_absent_warning',
              `Dear ${employee.employeeName}, you have been automatically marked as absent for today (${today}) because you checked in but did not check out. Please contact HR if this is incorrect.`
            );
            
            console.log(`✅ Auto marked as absent: ${employee.employeeName}`);
          }
          
          results.push({
            employeeId: employee.id,
            employeeName: employee.employeeName,
            checkinTime: employee.check_in,
            absentMarked: absentMarked,
            date: today
          });
          
        } catch (error) {
          console.error(`❌ Failed to auto mark absent for ${employee.employeeName}:`, error);
          results.push({
            employeeId: employee.id,
            employeeName: employee.employeeName,
            absentMarked: false,
            error: error.message
          });
        }
      }
      
      console.log('✅ End-of-day auto absent marking completed:', {
        totalProcessed: employeesWithoutCheckout.length,
        absentMarked: results.filter(r => r.absentMarked).length,
        details: results
      });
      
      return results;
    } catch (error) {
      console.error('❌ Error in autoMarkAbsentAtEndOfDay:', error);
      throw error;
    }
  }

  // NEW: Process overtime for employees who checked out late
  async processOvertimeForLateCheckouts() {
    try {
      console.log('💰 Processing overtime for late checkouts...');
      const today = new Date().toISOString().split('T')[0];
      
      // Get employees who checked out today (have both check-in and check-out)
      const [employeesWithCheckout] = await db.query(`
        SELECT e.*, a.check_in, a.check_out, a.id as attendance_id
        FROM employees e
        INNER JOIN attendance a ON e.id = a.employee_id
        WHERE e.active = 1 
        AND DATE(a.date) = ? 
        AND a.check_in IS NOT NULL
        AND a.check_out IS NOT NULL
        AND a.status = 'Present'
      `, [today]);

      console.log(`👥 Found ${employeesWithCheckout.length} employees with checkout for today`);
      
      const results = [];
      
      for (const employee of employeesWithCheckout) {
        try {
          console.log(`🔍 Processing overtime for: ${employee.employeeName}`);
          
          // Calculate required checkout time based on check-in
          const requiredCheckoutTime = this.calculateCheckoutTime(employee.check_in, this.workingHours);
          
          // Calculate overtime
          const overtime = calculateOvertime(employee.check_in, employee.check_out, requiredCheckoutTime);
          
          if (overtime.overtimeHours > 0) {
            // Update attendance record with overtime
            const [updateResult] = await db.query(`
              UPDATE attendance 
              SET overtime_hours = ?,
                  overtime_amount = ?,
                  remarks = CONCAT(IFNULL(remarks, ''), ?),
                  updated_at = NOW()
              WHERE id = ?
            `, [
              overtime.overtimeHours.toString(),
              overtime.overtimeHours * 100, // Assuming 100 per hour rate
              ` | Auto-calculated overtime: ${overtime.overtimeFormatted}`,
              employee.attendance_id
            ]);
            
            if (updateResult.affectedRows > 0) {
              console.log(`✅ Overtime updated for ${employee.employeeName}: ${overtime.overtimeFormatted}`);
              
              // Send notification about overtime
              await this.sendReminder(
                employee.id,
                'overtime_notification',
                `Dear ${employee.employeeName}, overtime of ${overtime.overtimeFormatted} has been automatically calculated and recorded for today (${today}).`
              );
            }
            
            results.push({
              employeeId: employee.id,
              employeeName: employee.employeeName,
              checkinTime: employee.check_in,
              checkoutTime: employee.check_out,
              requiredCheckoutTime: requiredCheckoutTime,
              overtime: overtime,
              overtimeUpdated: true
            });
          } else {
            console.log(`ℹ️ No overtime for ${employee.employeeName}`);
            results.push({
              employeeId: employee.id,
              employeeName: employee.employeeName,
              checkinTime: employee.check_in,
              checkoutTime: employee.check_out,
              requiredCheckoutTime: requiredCheckoutTime,
              overtime: overtime,
              overtimeUpdated: false
            });
          }
          
        } catch (error) {
          console.error(`❌ Failed to process overtime for ${employee.employeeName}:`, error);
          results.push({
            employeeId: employee.id,
            employeeName: employee.employeeName,
            overtimeUpdated: false,
            error: error.message
          });
        }
      }
      
      console.log('✅ Overtime processing completed:', {
        totalProcessed: employeesWithCheckout.length,
        overtimeUpdated: results.filter(r => r.overtimeUpdated).length,
        details: results.map(r => ({
          employee: r.employeeName,
          overtime: r.overtime?.overtimeFormatted || '0',
          updated: r.overtimeUpdated
        }))
      });
      
      return results;
    } catch (error) {
      console.error('❌ Error in processOvertimeForLateCheckouts:', error);
      throw error;
    }
  }

  // Mark employee as absent
  async markEmployeeAbsent(employeeId) {
    try {
      const today = new Date().toISOString().split('T')[0];
      
      // Update attendance record to mark as absent
      const [result] = await db.query(`
        UPDATE attendance 
        SET status = 'Absent', 
            remarks = CONCAT(IFNULL(remarks, ''), ' | Automatically marked absent at end of day due to no check-out'),
            updated_at = NOW()
        WHERE employee_id = ? 
        AND DATE(date) = ? 
        AND check_out IS NULL
        AND status != 'Absent' 
      `, [employeeId, today]);
      
      if (result.affectedRows > 0) {
        console.log(`✅ Marked employee ${employeeId} as absent for ${today} (end-of-day auto marking)`);
        return true;
      } else {
        console.log(`ℹ️ Employee ${employeeId} already marked as absent for ${today} or record not found`);
        return false;
      }
    } catch (error) {
      console.error('Error marking employee as absent:', error);
      return false;
    }
  }

  // Get current scheduler status with detailed time information
  getSchedulerStatus() {
    const checkinTime = this.parseTimeToCron(this.checkinReminderTime);
    const workingMinutes = this.workingHoursToMinutes(this.workingHours);
    const endOfDayTime = this.parseTimeToCron(this.endOfDayTime);
    
    return {
      isRunning: this.isRunning,
      checkinReminderTime: this.checkinReminderTime,
      workingHours: this.workingHours,
      workingMinutes: workingMinutes,
      workingHoursFormatted: formatMinutesToReadable(workingMinutes),
      reminderBufferMinutes: this.reminderBufferMinutes,
      absentCheckMinutes: this.absentCheckMinutes,
      finalReminderMinutes: this.finalReminderMinutes,
      endOfDayTime: this.endOfDayTime,
      checkinCron: `${checkinTime.minutes} ${checkinTime.hours} * * *`,
      checkinFormatted: `${checkinTime.hours}:${checkinTime.minutes.toString().padStart(2, '0')}`,
      endOfDayCron: `${endOfDayTime.minutes} ${endOfDayTime.hours} * * *`,
      environment: this.isProduction ? 'production' : 'development/staging',
      smsEnabled: this.isProduction,
      // NEW: Add working day information
      isWorkingDayToday: isWorkingDay(),
      workingDayLogic: 'Weekdays + 1st & 3rd Saturdays only (excludes Sundays, 2nd & 4th Saturdays)'
    };
  }

  // Start the scheduler
  async start() {
    if (this.isRunning) {
      console.log('Scheduler is already running');
      return this.getSchedulerStatus();
    }

    console.log('Starting dynamic reminder scheduler...');

    // Update reminder times from settings
    const timeSettings = await this.updateReminderTimes();

    // Parse times for cron
    const checkinTime = this.parseTimeToCron(this.checkinReminderTime);
    const endOfDayTime = this.parseTimeToCron(this.endOfDayTime);

    console.log('📅 Scheduled times:', {
      checkin: `${checkinTime.hours}:${checkinTime.minutes.toString().padStart(2, '0')} (from settings: ${timeSettings.checkinReminderTime})`,
      workingHours: `${this.workingHours} (${timeSettings.workingMinutes} minutes)`,
      workingHoursFormatted: formatMinutesToReadable(timeSettings.workingMinutes),
      reminderBuffer: `${this.reminderBufferMinutes} minutes before checkout`,
      absentCheck: `${this.absentCheckMinutes} minutes after checkout`,
      finalReminder: `${this.finalReminderMinutes} minutes after checkout`,
      endOfDay: `${endOfDayTime.hours}:${endOfDayTime.minutes.toString().padStart(2, '0')} (auto absent marking)`,
      environment: this.isProduction ? 'production' : 'development/staging',
      smsEnabled: this.isProduction,
      workingDayLogic: 'Weekdays + 1st & 3rd Saturdays only'
    });

    // Schedule check-in reminder (fixed time) - ONLY ON WORKING DAYS
    cron.schedule(`${checkinTime.minutes} ${checkinTime.hours} * * *`, async () => {
      console.log(`⏰ Running check-in reminder job at ${checkinTime.hours}:${checkinTime.minutes.toString().padStart(2, '0')}`);
      
      // NEW: Check if today is a working day
      if (!isWorkingDay()) {
        console.log('📅 Today is not a working day. Skipping check-in reminders.');
        return;
      }
      
      try {
        await this.sendCheckinReminders();
      } catch (error) {
        console.error('Check-in reminder job failed:', error);
      }
    }, {
      timezone: "Asia/Kolkata"
    });

    // Schedule dynamic checkout reminders (every 5 minutes during afternoon/evening)
    cron.schedule('*/5 18-22 * * *', async () => {
      console.log(`⏰ Running dynamic checkout reminder job at ${new Date().toLocaleTimeString()}`);
      try {
        await this.sendDynamicCheckoutReminders();
      } catch (error) {
        console.error('Dynamic checkout reminder job failed:', error);
      }
    }, {
      timezone: "Asia/Kolkata"
    });

    // NEW: Schedule end-of-day auto absent marking (11:59 PM daily)
    cron.schedule(`${endOfDayTime.minutes} ${endOfDayTime.hours} * * *`, async () => {
      console.log(`🌙 Running end-of-day auto absent marking at ${endOfDayTime.hours}:${endOfDayTime.minutes.toString().padStart(2, '0')}`);
      try {
        await this.autoMarkAbsentAtEndOfDay();
      } catch (error) {
        console.error('End-of-day auto absent marking job failed:', error);
      }
    }, {
      timezone: "Asia/Kolkata"
    });

    // NEW: Schedule overtime processing (11:30 PM daily - before auto absent marking)
    cron.schedule('30 23 * * *', async () => {
      console.log('💰 Running overtime processing job at 23:30');
      try {
        await this.processOvertimeForLateCheckouts();
      } catch (error) {
        console.error('Overtime processing job failed:', error);
      }
    }, {
      timezone: "Asia/Kolkata"
    });

    this.isRunning = true;
    
    const status = this.getSchedulerStatus();
    console.log('✅ Dynamic reminder scheduler started successfully:', status);
    
    return status;
  }

  // Restart scheduler (useful when settings change)
  async restart() {
    console.log('🔄 Restarting reminder scheduler...');
    this.stop();
    return await this.start();
  }

  // Stop the scheduler
  stop() {
    this.isRunning = false;
    console.log('🛑 Reminder scheduler stopped');
    return this.getSchedulerStatus();
  }
}

// Create global reminder scheduler instance
const reminderScheduler = new ReminderScheduler();

// Import employees from Excel
const importEmployees = async (req, res) => {
  try {
    console.log('Import request received:', {
      file: req.file ? {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size
      } : 'No file'
    });

    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        message: 'No file uploaded' 
      });
    }

    let data = [];
    const fileExtension = req.file.originalname.toLowerCase().slice(req.file.originalname.lastIndexOf('.'));

    console.log('Processing file:', {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      extension: fileExtension,
      size: req.file.size
    });

    try {
      if (fileExtension === '.csv') {
        // Parse CSV file
        console.log('Processing as CSV file');
        const results = await new Promise((resolve, reject) => {
          const results = [];
          const bufferStream = new stream.PassThrough();
          bufferStream.end(req.file.buffer);
          
          bufferStream
            .pipe(csv())
            .on('data', (row) => {
              console.log('CSV row:', row);
              results.push(row);
            })
            .on('end', () => {
              console.log('CSV parsing completed. Rows found:', results.length);
              resolve(results);
            })
            .on('error', (error) => {
              console.error('CSV parsing error:', error);
              reject(error);
            });
        });
        data = results;
      } else {
        // Parse Excel file
        console.log('Processing as Excel file');
        const workbook = xlsx.read(req.file.buffer, { 
          type: 'buffer',
          cellDates: true,
          dateNF: 'yyyy-mm-dd'
        });
        
        const sheetName = workbook.SheetNames[0];
        console.log('Sheet name:', sheetName);
        
        const worksheet = workbook.Sheets[sheetName];
        data = xlsx.utils.sheet_to_json(worksheet, {
          raw: false,
          dateNF: 'yyyy-mm-dd'
        });
        
        console.log('Excel data parsed. Rows found:', data.length);
      }

      if (data.length === 0) {
        return res.status(400).json({ 
          success: false, 
          message: 'No data found in the file' 
        });
      }

      console.log('First few rows of data:', data.slice(0, 3));

    } catch (parseError) {
      console.error('Error parsing file:', parseError);
      return res.status(400).json({ 
        success: false, 
        message: 'Error parsing file. Please check the file format.',
        error: parseError.message 
      });
    }

    let imported = 0;
    let errors = [];

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      try {
        console.log(`Processing row ${i + 1}:`, row);

        // Map Excel columns to employee fields - UPDATED for your table structure
        const employeeData = {
          employeeNo: row['EMPLOYEE ID'] || row['EMPLOYEE ID'] || `EMP${Date.now()}${i}`,
          employeeName: row['NAME'] || row['NAME'] || '',
          position: row['DESIGNATION'] || row['DESIGNATION'] || '',
          department: '', // Default empty, you can map this later
          email:  row['OFFICE MAIL ID'] ||  row['Employee Personal Email ID']|| '',
          phone: row['Mobile NUMBER'] || row['Mobile NUMBER'] || '',
          status: row['STATUS'] || row['STATUS'] || 'Active',
          active: 1, // Default to active
          // Store ALL Excel data in meta including bloodGroup
          meta: {
            // Main fields from Excel
            slNo: row['SL:NO'] || row['SL:NO'] || '',
            employeeId: row['EMPLOYEE ID'] || row['EMPLOYEE ID'] || '',
            name: row['NAME'] || row['NAME'] || '',
            dateOfBirth: row['DATE OF BIRTH'] || row['DATE OF BIRTH'] || '',
            designation: row['DESIGNATION'] || row['DESIGNATION'] || '',
            bloodGroup: row['BLOOD GROUP'] || row['BLOOD GROUP'] || '',
            mobileNumber: row['Mobile NUMBER'] || row['Mobile NUMBER'] || '',
            status: row['STATUS'] || row['STATUS'] || '',
            emergencyContact: row['Emergency Contact'] || row['Emergency Contact'] || '',
            contactRelation: row['Contact Relation'] || row['Contact Relation'] || '',
            employeeAddress: row['EMPLOYEE ADDRESS'] || row['EMPLOYEE ADDRESS'] || '',
            personalEmail: row['Employee Personal Email ID'] || row['Employee Personal Email ID'] || '',
            officeAddress: row['OFFICE ADDRESS'] || row['OFFICE ADDRESS'] || '',
            officeMailId: row['OFFICE MAIL ID'] || row['OFFICE MAIL ID'] || '',
            officeNumber: row['OFFICE NUMBER'] || row['OFFICE NUMBER'] || '',
            joiningDate: row['JOINING DATE'] || row['JOINING DATE'] || '',
            exitDate: row['Exit date'] || row['Exit date'] || '',
            tenure: row['TENURE'] || row['TENURE'] || '',
            workExperience: row['WORK EXPERIECE'] || row['WORK EXPERIECE'] || '',
            education: row['EDUCATION'] || row['EDUCATION'] || '',
            aadhaarNo: row['AADHAAR NO'] || row['AADHAAR NO'] || '',
            panNo: row['PAN NO'] || row['PAN NO'] || '',
            accountDetail: row['ACCOUNT DETAIL'] || row['ACCOUNT DETAIL'] || ''
          }
        };

        // Validate required fields
        if (!employeeData.employeeName || employeeData.employeeName.trim() === '') {
          errors.push(`Row ${i + 2}: Employee NAME is required`);
          continue;
        }

        if (!employeeData.employeeNo || employeeData.employeeNo === `EMP${Date.now()}${i}` || employeeData.employeeNo.trim() === '') {
          errors.push(`Row ${i + 2}: EMPLOYEE ID is required`);
          continue;
        }

        // Check for duplicate employee number
        const [existing] = await db.query(
          'SELECT id FROM employees WHERE employeeNo = ?',
          [employeeData.employeeNo]
        );

        if (existing.length > 0) {
          errors.push(`Row ${i + 2}: Employee with ID ${employeeData.employeeNo} already exists`);
          continue;
        }

        // Format dates for database fields (only for fields that exist in your table)
        let birthday = null;
        let hiredOn = null;

        // Try to parse date of birth for birthday field
        if (employeeData.meta.dateOfBirth) {
          birthday = new Date(employeeData.meta.dateOfBirth);
          if (isNaN(birthday.getTime())) {
            birthday = null;
          }
        }

        // Try to parse joining date for hiredOn field
        if (employeeData.meta.joiningDate) {
          hiredOn = new Date(employeeData.meta.joiningDate);
          if (isNaN(hiredOn.getTime())) {
            hiredOn = null;
          }
        }

        // Insert employee - UPDATED to only use existing columns
        const [result] = await db.query(
          `INSERT INTO employees 
          (employeeName, employeeNo, position, department, email, phone, birthday, hiredOn, status, active, meta, createdAt, updatedAt) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            employeeData.employeeName.trim(),
            employeeData.employeeNo.trim(),
            employeeData.position.trim(),
            employeeData.department,
            employeeData.email.trim(),
            employeeData.phone.trim(),
            birthday,
            hiredOn,
            employeeData.status,
            employeeData.active,
            JSON.stringify(employeeData.meta)
          ]
        );

        imported++;
        console.log(`✅ Imported employee: ${employeeData.employeeName} (${employeeData.employeeNo})`);

      } catch (error) {
        console.error(`❌ Error importing row ${i + 2}:`, error);
        errors.push(`Row ${i + 2}: ${error.message}`);
      }
    }

    const response = {
      success: true,
      imported,
      total: data.length,
      message: `Successfully imported ${imported} out of ${data.length} employees`
    };

    if (errors.length > 0) {
      response.errors = errors.slice(0, 10); // Limit errors in response
      if (errors.length > 10) {
        response.message += ` (showing first 10 of ${errors.length} errors)`;
      }
    }

    console.log('Import completed:', response);
    res.json(response);

  } catch (error) {
    console.error('❌ Error in importEmployees:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to import employees',
      error: error.message 
    });
  }
};

// Generate secure token
const generateSecureToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Get all employees
const getAllEmployees = async (req, res) => {
  try {
    const [employees] = await db.query('SELECT * FROM employees ORDER BY createdAt DESC');
    
    // Include bank and salary details for all employees
    const employeesWithDetails = await Promise.all(
      employees.map(async (employee) => {
        // Get bank details
        const [bankDetails] = await db.query(
          'SELECT * FROM bank_details WHERE employeeId = ?', 
          [employee.id]
        );
        
        // Get salary details
        const [salaryDetails] = await db.query(
          'SELECT * FROM salary_details WHERE employeeId = ?', 
          [employee.id]
        );
        
        return {
          ...employee,
          bank: bankDetails.length > 0 ? bankDetails[0] : {},
          salary: salaryDetails.length > 0 ? salaryDetails[0] : {}
        };
      })
    );
    
    res.json(employeesWithDetails);
  } catch (err) {
    console.error('Error fetching employees:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Get employee by ID
const getEmployeeById = async (req, res) => {
  const { id } = req.params;
  try {
    const [employees] = await db.query('SELECT * FROM employees WHERE id = ?', [id]);
    
    if (employees.length === 0) {
      return res.status(404).json({ message: 'Employee not found' });
    }
    
    const employee = employees[0];
    
    // Get bank details
    const [bankDetails] = await db.query('SELECT * FROM bank_details WHERE employeeId = ?', [id]);
    
    if (bankDetails.length > 0) {
      employee.bank = bankDetails[0];
    } else {
      employee.bank = {};
    }
    
    // Get salary details
    const [salaryDetails] = await db.query('SELECT * FROM salary_details WHERE employeeId = ?', [id]);
    
    if (salaryDetails.length > 0) {
      employee.salary = salaryDetails[0];
    } else {
      employee.salary = {};
    }
    
    res.json(employee);
  } catch (err) {
    console.error('Error fetching employee:', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// Create employee - FIXED VERSION
const createEmployee = async (req, res) => {
  const {
    employeeName,
    employeeNo,
    photo,
    position,
    department,
    email,
    phone,
    birthday,
    location,
    address,
    hiredOn,
    hours,
    lanNo,
    gender,
    wfhEnabled, // Add wfhEnabled from request body
    bank, // Add bank data from request body
    salary // Add salary data from request body
  } = req.body;

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Check if employee already exists
    const [existing] = await connection.query(
      'SELECT id FROM employees WHERE email = ? OR employeeNo = ?',
      [email, employeeNo]
    );

    if (existing.length > 0) {
      await connection.rollback();
      return res.status(400).json({ 
        message: 'Employee with this email or employee number already exists' 
      });
    }

    const metaData = {};
    if (lanNo && lanNo.trim() !== '') {
      metaData.lan_no = lanNo.trim();
      metaData.lan_updated_at = new Date().toISOString();
    }

    if (gender && gender.trim() !== '') {
      metaData.gender = gender.trim();
    }

    // FIX: Use wfhEnabled from request body instead of undefined formData
    metaData.wfh_enabled = wfhEnabled || false;
    metaData.wfh_updated_at = new Date().toISOString();

    // Insert employee
    const [result] = await connection.query(
      `INSERT INTO employees 
      (employeeName, employeeNo, photo, position, department, email, phone, birthday, location, address, hiredOn, hours, meta) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        employeeName,
        employeeNo,
        photo || null,
        position,
        department,
        email,
        phone,
        birthday || null,
        location || null,
        address || null,
        hiredOn || null,
        hours || null,
        Object.keys(metaData).length > 0 ? JSON.stringify(metaData) : null
      ]
    );

    const employeeId = result.insertId;

    // Insert bank details if provided
    if (bank && Object.keys(bank).length > 0) {
      const {
        accountHolderName,
        accountNumber,
        bankName,
        bankAddress,
        ifscCode,
        accountType,
        uanNumber
      } = bank;

      await connection.query(
        `INSERT INTO bank_details 
        (employeeId, accountHolderName, accountNumber, bankName, bankAddress, ifscCode, accountType, uanNumber) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          employeeId,
          accountHolderName || null,
          accountNumber || null,
          bankName || null,
          bankAddress || null,
          ifscCode || null,
          accountType || null,
          uanNumber || null
        ]
      );
    }

    // Insert salary details if provided
    if (salary && Object.keys(salary).length > 0) {
      const {
        basicSalary,
        hra,
        conveyanceAllowance,
        medicalAllowance,
        specialAllowance,
        otherAllowances,
        providentFund,
        professionalTax,
        incomeTax,
        otherDeductions,
        totalEarnings,
        totalDeductions,
        netSalary
      } = salary;

      await connection.query(
        `INSERT INTO salary_details 
        (employeeId, basicSalary, hra, conveyanceAllowance, medicalAllowance, specialAllowance, otherAllowances, 
         providentFund, professionalTax, incomeTax, otherDeductions, totalEarnings, totalDeductions, netSalary, createdAt, updatedAt) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          employeeId,
          parseFloat(basicSalary) || 0,
          parseFloat(hra) || 0,
          parseFloat(conveyanceAllowance) || 0,
          parseFloat(medicalAllowance) || 0,
          parseFloat(specialAllowance) || 0,
          parseFloat(otherAllowances) || 0,
          parseFloat(providentFund) || 0,
          parseFloat(professionalTax) || 0,
          parseFloat(incomeTax) || 0,
          parseFloat(otherDeductions) || 0,
          parseFloat(totalEarnings) || 0,
          parseFloat(totalDeductions) || 0,
          parseFloat(netSalary) || 0
        ]
      );
    }

    await connection.commit();

    res.status(201).json({ 
      message: 'Employee created successfully', 
      id: employeeId 
    });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Error creating employee:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
};

// Update employee
const updateEmployee = async (req, res) => {
  const { id } = req.params;
  const {
    employeeName,
    employeeNo,
    photo,
    position,
    department,
    email,
    phone,
    birthday,
    location,
    address,
    hiredOn,
    hours,
    lanNo,
    gender,
    wfhEnabled, // Add wfhEnabled from request body
    bank, // Add bank data from request body
    salary // Add salary data from request body
  } = req.body;

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // Check if employee exists
    const [existing] = await connection.query('SELECT id FROM employees WHERE id = ?', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: 'Employee not found' });
    }

    let metaData = {};
    try {
      metaData = existing[0].meta ? JSON.parse(existing[0].meta) : {};
    } catch (e) {
      metaData = {};
    }

    // Update LAN IP in meta
    if (lanNo !== undefined) {
      if (lanNo && lanNo.trim() !== '') {
        metaData.lan_no = lanNo.trim();
        metaData.lan_updated_at = new Date().toISOString();
      } else {
        // Remove lan_no if empty
        delete metaData.lan_no;
        delete metaData.lan_updated_at;
      }
    }

    if (gender !== undefined) {
      if (gender && gender.trim() !== '') {
        metaData.gender = gender.trim();
      } else {
        delete metaData.gender;
      }
    }

    // FIX: Use wfhEnabled from request body instead of undefined formData
    if (wfhEnabled !== undefined) {
      metaData.wfh_enabled = wfhEnabled || false;
      metaData.wfh_updated_at = new Date().toISOString();
    }

    // Update employee
    await connection.query(
      `UPDATE employees SET 
      employeeName=?, employeeNo=?, photo=?, position=?, department=?, email=?, phone=?, birthday=?, location=?, address=?, hiredOn=?, hours=?, meta=?
      WHERE id=?`,
      [
        employeeName,
        employeeNo,
        photo || null,
        position,
        department,
        email,
        phone,
        birthday || null,
        location || null,
        address || null,
        hiredOn || null,
        hours || null,
        Object.keys(metaData).length > 0 ? JSON.stringify(metaData) : null,
        id
      ]
    );

    // Handle bank details
    if (bank && Object.keys(bank).length > 0) {
      const {
        accountHolderName,
        accountNumber,
        bankName,
        bankAddress,
        ifscCode,
        accountType,
        uanNumber
      } = bank;

      // Check if bank details already exist
      const [existingBank] = await connection.query(
        'SELECT id FROM bank_details WHERE employeeId = ?',
        [id]
      );

      if (existingBank.length > 0) {
        // Update existing bank details
        await connection.query(
          `UPDATE bank_details SET 
          accountHolderName=?, accountNumber=?, bankName=?, bankAddress=?, ifscCode=?, accountType=?, uanNumber=?
          WHERE employeeId=?`,
          [
            accountHolderName || null,
            accountNumber || null,
            bankName || null,
            bankAddress || null,
            ifscCode || null,
            accountType || null,
            uanNumber || null,
            id
          ]
        );
      } else {
        // Insert new bank details
        await connection.query(
          `INSERT INTO bank_details 
          (employeeId, accountHolderName, accountNumber, bankName, bankAddress, ifscCode, accountType, uanNumber) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            accountHolderName || null,
            accountNumber || null,
            bankName || null,
            bankAddress || null,
            ifscCode || null,
            accountType || null,
            uanNumber || null
          ]
        );
      }
    }

    // Handle salary details
    if (salary && Object.keys(salary).length > 0) {
      const {
        basicSalary,
        hra,
        conveyanceAllowance,
        medicalAllowance,
        specialAllowance,
        otherAllowances,
        providentFund,
        professionalTax,
        incomeTax,
        otherDeductions,
        totalEarnings,
        totalDeductions,
        netSalary
      } = salary;

      // Check if salary details already exist
      const [existingSalary] = await connection.query(
        'SELECT id FROM salary_details WHERE employeeId = ?',
        [id]
      );

      if (existingSalary.length > 0) {
        // Update existing salary details
        await connection.query(
          `UPDATE salary_details SET 
          basicSalary=?, hra=?, conveyanceAllowance=?, medicalAllowance=?, specialAllowance=?, otherAllowances=?,
          providentFund=?, professionalTax=?, incomeTax=?, otherDeductions=?, totalEarnings=?, totalDeductions=?, netSalary=?, updatedAt=NOW()
          WHERE employeeId=?`,
          [
            parseFloat(basicSalary) || 0,
            parseFloat(hra) || 0,
            parseFloat(conveyanceAllowance) || 0,
            parseFloat(medicalAllowance) || 0,
            parseFloat(specialAllowance) || 0,
            parseFloat(otherAllowances) || 0,
            parseFloat(providentFund) || 0,
            parseFloat(professionalTax) || 0,
            parseFloat(incomeTax) || 0,
            parseFloat(otherDeductions) || 0,
            parseFloat(totalEarnings) || 0,
            parseFloat(totalDeductions) || 0,
            parseFloat(netSalary) || 0,
            id
          ]
        );
      } else {
        // Insert new salary details
        await connection.query(
          `INSERT INTO salary_details 
          (employeeId, basicSalary, hra, conveyanceAllowance, medicalAllowance, specialAllowance, otherAllowances, 
           providentFund, professionalTax, incomeTax, otherDeductions, totalEarnings, totalDeductions, netSalary, createdAt, updatedAt) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            id,
            parseFloat(basicSalary) || 0,
            parseFloat(hra) || 0,
            parseFloat(conveyanceAllowance) || 0,
            parseFloat(medicalAllowance) || 0,
            parseFloat(specialAllowance) || 0,
            parseFloat(otherAllowances) || 0,
            parseFloat(providentFund) || 0,
            parseFloat(professionalTax) || 0,
            parseFloat(incomeTax) || 0,
            parseFloat(otherDeductions) || 0,
            parseFloat(totalEarnings) || 0,
            parseFloat(totalDeductions) || 0,
            parseFloat(netSalary) || 0
          ]
        );
      }
    }

    await connection.commit();

    res.json({ message: 'Employee updated successfully' });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Error updating employee:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
};

// Delete employee
const deleteEmployee = async (req, res) => {
  const { id } = req.params;
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [existing] = await connection.query('SELECT id FROM employees WHERE id = ?', [id]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: 'Employee not found' });
    }

    // Delete salary details first
    await connection.query('DELETE FROM salary_details WHERE employeeId = ?', [id]);
    
    // Delete bank details
    await connection.query('DELETE FROM bank_details WHERE employeeId = ?', [id]);
    
    // Then delete employee
    await connection.query('DELETE FROM employees WHERE id = ?', [id]);
    
    await connection.commit();
    
    res.json({ message: 'Employee deleted successfully' });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Error deleting employee:', err);
    res.status(500).json({ message: 'Server error' });
  } finally {
    if (connection) connection.release();
  }
};

const sendStaffInvite = async (req, res) => {
  const { id } = req.params;
  
  try {
    // Get employee details
    const [employees] = await db.query('SELECT * FROM employees WHERE id = ?', [id]);
    
    if (employees.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Employee not found' 
      });
    }
    
    const employee = employees[0];
    const { employeeName, email, position, department, employeeNo } = employee;
    
    // Validate email
    if (!email || email.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Employee email is required to send invitation'
      });
    }
    
    // Generate random 8-digit password
    const randomPassword = Math.random().toString(36).slice(-8);
    
    // Hash the password before storing
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(randomPassword, saltRounds);
    
    let userId;
    
    // Check if user already exists
    const [existingUsers] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    
    if (existingUsers.length > 0) {
      // Update existing user with hashed password and link to employee
      userId = existingUsers[0].id;
      await db.query(
        'UPDATE users SET name = ?, role = ?, password = ?, employee_id = ?, updatedAt = NOW() WHERE email = ?',
        [employeeName, 'staff', hashedPassword, id, email]
      );
      
      // Also update the employee record with user_id
      await db.query(
        'UPDATE employees SET user_id = ? WHERE id = ?',
        [userId, id]
      );
    } else {
      // Create new user with hashed password
      const [userResult] = await db.query(
        'INSERT INTO users (name, email, password, role, employee_id, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
        [employeeName, email, hashedPassword, 'staff', id]
      );
      
      userId = userResult.insertId;
      
      // Update the employee record with user_id
      await db.query(
        'UPDATE employees SET user_id = ? WHERE id = ?',
        [userId, id]
      );
    }

    // Create staff portal link
    const staffPortalLink = process.env.FRONTEND_URL || 'http://16.16.110.203';
    const loginLink = `${staffPortalLink}/login`;

    // Email HTML with professional styling
    const emailHtml = `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>Staff Portal Invitation</title>
    </head>
    <body style="font-family: Arial, sans-serif; background: #f7f7fb; margin: 0; padding: 0;">
      <div style="max-width: 600px; margin: 30px auto; background: #fff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
        
        <!-- Logo Section -->
        <div style="text-align: center; margin-bottom: 30px;">
          <img src="https://icebergsindia.com/wp-content/uploads/2020/01/4a4f2132b7-IMG_3970-1-e1743063706285.png" 
               alt="Icebergs India Logo" 
               style="max-width: 250px; height: auto;" />
        </div>

        <!-- Title -->
        <h2 style="color: #091D78; margin-bottom: 20px; text-align: center; font-size: 24px;">
          Welcome to Staff Portal
        </h2>

        <!-- Welcome Message -->
        <p style="font-size: 15px; color: #555; line-height: 1.6; margin-bottom: 20px;">
          Hi <strong>${employeeName}</strong>,
        </p>
        
        <p style="font-size: 15px; color: #555; line-height: 1.6; margin-bottom: 25px;">
          Welcome to the team! Your staff portal account has been created. 
          You can now access your employee dashboard, view your details, and manage your profile.
        </p>

        <!-- Login Credentials Box -->
        <div style="background: #f8fafc; border: 2px solid #091D78; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
          <h3 style="font-size: 18px; font-weight: 600; color: #091D78; margin: 0 0 15px 0; text-align: center;">
            Your Login Credentials
          </h3>
          
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0;">
                <strong style="color: #374151;">Email:</strong>
              </td>
              <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; text-align: right;">
                <span style="color: #111827;">${email}</span>
              </td>
            </tr>
            <tr>
              <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0;">
                <strong style="color: #374151;">Password:</strong>
              </td>
              <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; text-align: right;">
                <code style="background: #fff; padding: 4px 8px; border-radius: 4px; color: #091D78; font-weight: bold;">${randomPassword}</code>
              </td>
            </tr>
            <tr>
              <td style="padding: 10px 0;">
                <strong style="color: #374151;">Role:</strong>
              </td>
              <td style="padding: 10px 0; text-align: right;">
                <span style="color: #111827;">Staff</span>
              </td>
            </tr>
          </table>
        </div>

        <!-- Employee Details Box -->
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; margin-bottom: 25px;">
          <h3 style="font-size: 18px; font-weight: 600; color: #091D78; margin: 0 0 15px 0; text-align: center;">
            Your Employee Details
          </h3>
          
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0; border-bottom: 1px dashed #e2e8f0;">
                <strong style="color: #374151;">Full Name:</strong>
              </td>
              <td style="padding: 8px 0; border-bottom: 1px dashed #e2e8f0; text-align: right;">
                <span style="color: #111827;">${employeeName}</span>
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 0; border-bottom: 1px dashed #e2e8f0;">
                <strong style="color: #374151;">Position:</strong>
              </td>
              <td style="padding: 8px 0; border-bottom: 1px dashed #e2e8f0; text-align: right;">
                <span style="color: #111827;">${position}</span>
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 0; border-bottom: 1px dashed #e2e8f0;">
                <strong style="color: #374151;">Department:</strong>
              </td>
              <td style="padding: 8px 0; border-bottom: 1px dashed #e2e8f0; text-align: right;">
                <span style="color: #111827;">${department}</span>
              </td>
            </tr>
            <tr>
              <td style="padding: 8px 0;">
                <strong style="color: #374151;">Employee ID:</strong>
              </td>
              <td style="padding: 8px 0; text-align: right;">
                <span style="color: #111827;">${employeeNo}</span>
              </td>
            </tr>
          </table>
        </div>

        <!-- Login Button -->
        <div style="text-align: center; margin: 30px 0;">
          <a href="${loginLink}" 
             style="display: inline-block; background: #091D78; color: #fff; padding: 14px 40px; 
                    border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 16px;">
            Login to Staff Portal
          </a>
        </div>

        <!-- Security Note -->
        <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 15px; margin-bottom: 20px;">
          <p style="margin: 0; color: #856404; font-size: 14px; line-height: 1.5;">
            <strong>🔒 Security Note:</strong> For your security, please change your password after your first login.
          </p>
        </div>

        <!-- Footer -->
        <div style="border-top: 2px solid #e2e8f0; padding-top: 20px; margin-top: 30px;">
          <p style="font-size: 14px; color: #555; line-height: 1.6; margin: 0;">
            If you have any issues accessing your account, please contact the HR department.
          </p>
          <p style="font-size: 14px; color: #555; margin: 15px 0 0 0;">
            <strong>Best regards,</strong><br/>
            The Icebergs Team
          </p>
        </div>

        <!-- Contact Info -->
        <div style="text-align: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
          <p style="font-size: 12px; color: #888; margin: 5px 0;">
            <a href="https://icebergsindia.com" style="color: #091D78; text-decoration: none;">www.icebergsindia.com</a>
          </p>
          <p style="font-size: 12px; color: #888; margin: 5px 0;">
            ${process.env.EMAIL_USER || 'garan6104@gmail.com'}
          </p>
        </div>

      </div>
    </body>
    </html>`;

    // Plain text version
    const textVersion = `
Staff Portal Invitation

Hi ${employeeName},

Welcome to the team! Your staff portal account has been created.

Your Login Credentials:
------------------------
Email: ${email}
Password: ${randomPassword}
Role: Staff

Your Employee Details:
---------------------
Name: ${employeeName}
Position: ${position}
Department: ${department}
Employee ID: ${employeeNo}

Login Link: ${loginLink}

🔒 Security Note: For your security, please change your password after your first login.

If you have any issues accessing your account, please contact the HR department.

Best regards,
The Icebergs Team

www.icebergsindia.com
${process.env.EMAIL_USER || 'garan6104@gmail.com'}
    `;

    // Create Gmail transporter directly
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    // Email options
    const mailOptions = {
      from: `"Icebergs India - HR Department" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `Staff Portal Invitation - ${employeeName}`,
      html: emailHtml,
      text: textVersion
    };

    // Send email
    const info = await transporter.sendMail(mailOptions);

    console.log(`✅ Staff invitation email sent successfully to ${email}`);
    console.log('Message ID:', info.messageId);
    
    res.json({
      success: true,
      message: 'Staff invitation sent successfully',
      emailSent: true,
      credentials: {
        email: email,
        password: randomPassword
      }
    });

  } catch (error) {
    console.error('❌ Error sending staff invitation:', error);
    
    let errorMessage = 'Failed to send staff invitation';
    
    if (error.code === 'EAUTH') {
      errorMessage = 'Email authentication failed. Please check your Gmail credentials in .env file';
    } else if (error.code === 'ECONNECTION' || error.code === 'ETIMEDOUT') {
      errorMessage = 'Cannot connect to Gmail server. Please check your internet connection.';
    } else if (error.responseCode === 535) {
      errorMessage = 'Invalid Gmail credentials. Please verify EMAIL_USER and EMAIL_PASS in .env';
    }
    
    res.status(500).json({
      success: false,
      message: errorMessage,
      error: error.message,
      code: error.code
    });
  }
};

// Validate invitation
const validateInvitation = async (req, res) => {
  try {
    const { invitation } = req.query;

    console.log('🔍 Received invitation parameter:', invitation);

    if (!invitation) {
      return res.status(400).json({ 
        valid: false, 
        message: 'Invalid invitation link' 
      });
    }

    // Decode the invitation data
    let invitationData;
    try {
      const decodedData = Buffer.from(invitation, 'base64').toString('utf8');
      invitationData = JSON.parse(decodedData);
      console.log('📧 Decoded invitation data:', invitationData);
    } catch (decodeError) {
      console.error('❌ Error decoding invitation:', decodeError);
      return res.status(400).json({ 
        valid: false, 
        message: 'Invalid invitation format' 
      });
    }
    
    const { email, token, timestamp } = invitationData;

    if (!token) {
      return res.status(400).json({ 
        valid: false, 
        message: 'Invalid invitation data' 
      });
    }

    console.log('🔐 Validating invitation token:', token);

    // Check if invitation is expired (24 hours)
    const invitationAge = Date.now() - timestamp;
    const twentyFourHours = 24 * 60 * 60 * 1000;
    
    console.log(`⏰ Invitation age: ${invitationAge}ms, Max: ${twentyFourHours}ms`);
    
    if (invitationAge > twentyFourHours) {
      return res.json({ 
        valid: false, 
        message: 'Invitation link has expired. Please request a new one.' 
      });
    }

    // Check database for valid invitation token ONLY
    const [employees] = await db.query(
      `SELECT e.* FROM employees e
       WHERE e.invitation_token = ? 
       AND e.invitation_expires > NOW()`,
      [token]
    );

    console.log('✅ Valid invitation check:', employees.length > 0 ? 'Yes' : 'No');

    if (employees.length === 0) {
      // Debug: Check what tokens are in the database
      const [allTokens] = await db.query(
        'SELECT email, invitation_token, invitation_expires FROM employees WHERE invitation_token IS NOT NULL'
      );
      
      console.log('📊 All invitation tokens in database:', allTokens);
      
      return res.json({ 
        valid: false, 
        message: 'Invalid or expired invitation token' 
      });
    }

    const employee = employees[0];

    // Optional: Verify the email from token matches the invitation email
    if (employee.email !== email) {
      console.warn('⚠️ Email mismatch:', { tokenEmail: employee.email, invitationEmail: email });
      return res.json({ 
        valid: false, 
        message: 'Invitation token does not match email address' 
      });
    }

    res.json({
      valid: true,
      employee: {
        id: employee.id,
        employeeName: employee.employeeName,
        email: employee.email,
        position: employee.position,
        department: employee.department,
        employeeNo: employee.employeeNo
      }
    });

  } catch (error) {
    console.error('❌ Error validating invitation:', error);
    res.status(500).json({ 
      valid: false, 
      message: 'Server error during validation' 
    });
  }
};

// Complete invitation
const completeInvitation = async (req, res) => {
  const { email, token } = req.body;

  try {
    await db.query(
      `UPDATE employees SET 
       invitation_token = NULL, 
       invitation_expires = NULL,
       invitation_completed = NOW()
       WHERE email = ? AND invitation_token = ?`,
      [email, token]
    );

    res.json({ 
      success: true, 
      message: 'Invitation completed successfully' 
    });
  } catch (error) {
    console.error('Error completing invitation:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
};

const checkAndSendReminderNotifications = async () => {
  try {
    console.log('🔔 Checking attendance settings for reminders...');
    
    // Get attendance settings
    const [settings] = await db.query(
      'SELECT * FROM attendance_settings ORDER BY created_at DESC LIMIT 1'
    );
    
    if (settings.length === 0) {
      console.log('No attendance settings found');
      return {
        success: false,
        message: 'No attendance settings configured'
      };
    }
    
    const setting = settings[0];
    const settingsData = setting.settings_data;
    
    console.log('📋 Attendance settings data:', settingsData);
    
    // Check if reminderTime exists in settings_data
    if (!settingsData || !settingsData.reminderTime) {
      console.log('No reminderTime configured in attendance settings');
      return {
        success: false,
        message: 'No reminder time configured'
      };
    }
    
    const reminderTime = settingsData.reminderTime;
    const currentTime = new Date();
    const currentHours = currentTime.getHours();
    const currentMinutes = currentTime.getMinutes();
    
    console.log(`⏰ Current time: ${currentHours}:${currentMinutes}, Reminder time: ${reminderTime}`);
    
    // Parse reminder time (assuming format like "09:00" or "9:00")
    const [reminderHours, reminderMinutes] = reminderTime.split(':').map(Number);
    
    // Check if current time matches reminder time (within a 1-minute window)
    const timeDifference = Math.abs(
      (currentHours * 60 + currentMinutes) - (reminderHours * 60 + reminderMinutes)
    );
    
    if (timeDifference > 1) {
      console.log(`Current time doesn't match reminder time. Difference: ${timeDifference} minutes`);
      return {
        success: false,
        message: 'Not yet time for reminder'
      };
    }
    
    console.log('✅ Time matched! Sending reminder notifications...');
    
    // Get today's date in YYYY-MM-DD format
    const today = new Date().toISOString().split('T')[0];
    
    // Get all active staff users who haven't checked in today
    const [users] = await db.query(`
      SELECT DISTINCT u.id, u.name, u.email, u.employee_id, e.employeeName 
      FROM users u 
      LEFT JOIN employees e ON u.employee_id = e.id 
      LEFT JOIN attendance a ON u.employee_id = a.employee_id AND a.date = ? 
      WHERE u.role = 'staff' 
      AND a.id IS NULL -- No attendance record for today
    `, [today]);
    
    if (users.length === 0) {
      console.log('No staff users found who haven\'t checked in today');
      return {
        success: false,
        message: 'All staff members have already checked in today or no staff users found'
      };
    }
    
    console.log(`👥 Found ${users.length} staff users who haven't checked in today`);
    
    // Filter users who haven't received a reminder today
    const usersToNotify = [];
    const notificationPromises = [];
    
    for (const user of users) {
      // Check if user already received a reminder today
      const [existingNotifications] = await db.query(`
        SELECT id FROM notifications 
        WHERE user_id = ? 
        AND type = 'attendance_reminder' 
        AND DATE(created_at) = ? 
        LIMIT 1
      `, [user.id, today]);
      
      if (existingNotifications.length === 0) {
        usersToNotify.push(user);
        
        // Create notification for this user
        notificationPromises.push(
          NotificationService.createNotification({
            userIds: [user.id],
            title: 'Attendance Reminder',
            message: `⏰ Daily attendance reminder: Please mark your attendance for today.`,
            type: 'attendance',
            module: 'attendance',
            moduleId: null
          })
        );
      } else {
        console.log(`ℹ️ User ${user.name} already received reminder today, skipping...`);
      }
    }
    
    if (usersToNotify.length === 0) {
      console.log('All eligible users have already received reminders today');
      return {
        success: false,
        message: 'All eligible staff members have already received reminders today'
      };
    }
    
    console.log(`📢 Sending reminders to ${usersToNotify.length} users...`);
    
    // Send all notifications
    await Promise.all(notificationPromises);
    
    console.log('✅ Attendance reminder notifications sent successfully');
    
    return {
      success: true,
      message: `Reminder notifications sent to ${usersToNotify.length} staff members`,
      usersNotified: usersToNotify.length,
      reminderTime: reminderTime,
      details: {
        totalStaff: users.length,
        notified: usersToNotify.length,
        alreadyNotified: users.length - usersToNotify.length
      }
    };
    
  } catch (error) {
    console.error('❌ Error in checkAndSendReminderNotifications:', error);
    return {
      success: false,
      message: 'Failed to send reminder notifications',
      error: error.message
    };
  }
};

const triggerReminderManually = async (req, res) => {
  try {
    const result = await checkAndSendReminderNotifications();
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    console.error('Error triggering reminder manually:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger reminder',
      error: error.message
    });
  }
};

// Set up interval to run this function automatically
const setupReminderInterval = () => {
  // Check every minute (60000 milliseconds)
  setInterval(async () => {
    try {
      await checkAndSendReminderNotifications();
    } catch (error) {
      console.error('Error in reminder interval:', error);
    }
  }, 60000); // 60 seconds
  
  console.log('⏰ Attendance reminder system started - checking every minute');
};

// NEW REMINDER FUNCTIONS

// Start reminder scheduler
const startReminderScheduler = () => {
  reminderScheduler.start();
};

// Manual check-in reminder
const sendCheckinReminder = async (req, res) => {
  try {
    const { employeeId } = req.body;

    if (employeeId) {
      // Send to specific employee
      const result = await reminderScheduler.sendReminder(
        employeeId, 
        'checkin'
      );
      res.json({
        success: true,
        message: 'Check-in reminder sent successfully',
        data: result
      });
    } else {
      // Send to all employees without check-in
      const results = await reminderScheduler.sendCheckinReminders();
      res.json({
        success: true,
        message: 'Check-in reminders sent successfully',
        data: results
      });
    }
  } catch (error) {
    console.error('Error sending check-in reminder:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send check-in reminder'
    });
  }
};

// Manual dynamic checkout reminder
const sendDynamicCheckoutReminder = async (req, res) => {
  try {
    const { employeeId } = req.body;

    if (employeeId) {
      // Send to specific employee
      const employee = await reminderScheduler.getEmployeesWithoutCheckout();
      const specificEmployee = employee.find(emp => emp.id === parseInt(employeeId));
      
      if (!specificEmployee) {
        return res.status(404).json({
          success: false,
          message: 'Employee not found or already checked out'
        });
      }

      const checkoutTime = reminderScheduler.calculateCheckoutTime(specificEmployee.check_in, reminderScheduler.workingHours);
      const result = await reminderScheduler.sendReminder(
        employeeId, 
        'checkout_before',
        `Dear ${specificEmployee.employeeName}, please remember to check out. Your calculated checkout time is ${checkoutTime}.`,
        checkoutTime
      );
      
      res.json({
        success: true,
        message: 'Dynamic checkout reminder sent successfully',
        data: {
          ...result,
          checkinTime: specificEmployee.check_in,
          checkoutTime: checkoutTime
        }
      });
    } else {
      // Send to all employees without check-out
      const results = await reminderScheduler.sendDynamicCheckoutReminders();
      res.json({
        success: true,
        message: 'Dynamic checkout reminders sent successfully',
        data: results
      });
    }
  } catch (error) {
    console.error('Error sending dynamic checkout reminder:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send dynamic checkout reminder'
    });
  }
};

// NEW: Manual end-of-day auto absent marking
const manualAutoMarkAbsent = async (req, res) => {
  try {
    const results = await reminderScheduler.autoMarkAbsentAtEndOfDay();
    
    res.json({
      success: true,
      message: 'End-of-day auto absent marking completed',
      data: results
    });
  } catch (error) {
    console.error('Error in manual auto mark absent:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to run auto absent marking',
      error: error.message
    });
  }
};

// NEW: Manual overtime processing
const manualProcessOvertime = async (req, res) => {
  try {
    const results = await reminderScheduler.processOvertimeForLateCheckouts();
    
    res.json({
      success: true,
      message: 'Overtime processing completed',
      data: results
    });
  } catch (error) {
    console.error('Error in manual overtime processing:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process overtime',
      error: error.message
    });
  }
};

// Test SMS - Updated to respect environment
const testSMS = async (req, res) => {
  try {
    const { phone, message } = req.body;
    
    if (process.env.NODE_ENV !== 'production') {
      return res.json({
        success: true,
        message: 'SMS would be sent in production environment',
        data: {
          skipped: true,
          environment: process.env.NODE_ENV,
          phone: phone,
          message: message,
          note: 'SMS is only sent in production environment to avoid Twilio charges'
        }
      });
    }
    
    const result = await reminderScheduler.sendSMS(phone, message || 'Test message from attendance system');
    
    res.json({
      success: true,
      message: 'SMS sent successfully',
      data: result
    });
  } catch (error) {
    console.error('Error sending test SMS:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send test SMS'
    });
  }
};

// Get reminder status
const getReminderStatus = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get employees without check-in
    const employeesWithoutCheckin = await reminderScheduler.getEmployeesWithoutCheckin();
    
    // Get employees without check-out
    const employeesWithoutCheckout = await reminderScheduler.getEmployeesWithoutCheckout();
    
    // Get scheduler status with actual times
    const schedulerStatus = reminderScheduler.getSchedulerStatus();
    
    res.json({
      success: true,
      data: {
        schedulerRunning: reminderScheduler.isRunning,
        date: today,
        employeesWithoutCheckin: employeesWithoutCheckin.length,
        employeesWithoutCheckout: employeesWithoutCheckout.length,
        checkinReminderTime: schedulerStatus.checkinReminderTime,
        workingHours: schedulerStatus.workingHours,
        workingMinutes: schedulerStatus.workingMinutes,
        workingHoursFormatted: schedulerStatus.workingHoursFormatted,
        reminderBufferMinutes: schedulerStatus.reminderBufferMinutes,
        absentCheckMinutes: schedulerStatus.absentCheckMinutes,
        finalReminderMinutes: schedulerStatus.finalReminderMinutes,
        endOfDayTime: schedulerStatus.endOfDayTime,
        actualSchedule: {
          checkin: schedulerStatus.checkinFormatted,
          endOfDay: schedulerStatus.endOfDayTime
        },
        totalActiveEmployees: employeesWithoutCheckin.length + employeesWithoutCheckout.length,
        dynamicCheckoutEnabled: true,
        autoAbsentEnabled: true,
        overtimeProcessingEnabled: true
      }
    });
  } catch (error) {
    console.error('Error getting reminder status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get reminder status',
      error: error.message
    });
  }
};

// Calculate checkout time for a specific employee with minute precision
const calculateEmployeeCheckoutTime = async (req, res) => {
  try {
    const { employeeId } = req.params;
    
    const checkinTime = await reminderScheduler.getEmployeeCheckinTime(employeeId);
    
    if (!checkinTime) {
      return res.status(404).json({
        success: false,
        message: 'Employee has not checked in today'
      });
    }
    
    const checkoutTime = reminderScheduler.calculateCheckoutTime(checkinTime, reminderScheduler.workingHours);
    const reminderTimes = reminderScheduler.calculateReminderTimes(checkoutTime);
    const workingMinutes = reminderScheduler.workingHoursToMinutes(reminderScheduler.workingHours);
    
    res.json({
      success: true,
      data: {
        employeeId: parseInt(employeeId),
        checkinTime: checkinTime,
        workingHours: reminderScheduler.workingHours,
        workingMinutes: workingMinutes,
        workingHoursFormatted: formatMinutesToReadable(workingMinutes),
        calculatedCheckoutTime: checkoutTime,
        reminderSchedule: reminderTimes,
        calculationDetails: {
          checkinMinutes: (parseInt(checkinTime.split(':')[0]) * 60) + parseInt(checkinTime.split(':')[1]),
          workingMinutes: workingMinutes,
          totalCheckoutMinutes: (parseInt(checkinTime.split(':')[0]) * 60) + parseInt(checkinTime.split(':')[1]) + workingMinutes
        }
      }
    });
  } catch (error) {
    console.error('Error calculating checkout time:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate checkout time',
      error: error.message
    });
  }
};

// Test checkout calculation with sample data
const testCheckoutCalculation = async (req, res) => {
  try {
    const { checkinTime, workingHours } = req.body;
    
    // Use provided values or defaults
    const testCheckinTime = checkinTime || '09:30';
    const testWorkingHours = workingHours || reminderScheduler.workingHours;
    
    const checkoutTime = reminderScheduler.calculateCheckoutTime(testCheckinTime, testWorkingHours);
    const reminderTimes = reminderScheduler.calculateReminderTimes(checkoutTime);
    const workingMinutes = reminderScheduler.workingHoursToMinutes(testWorkingHours);
    
    res.json({
      success: true,
      data: {
        testCheckinTime: testCheckinTime,
        testWorkingHours: testWorkingHours,
        workingMinutes: workingMinutes,
        workingHoursFormatted: formatMinutesToReadable(workingMinutes),
        calculatedCheckoutTime: checkoutTime,
        reminderSchedule: reminderTimes,
        calculationBreakdown: {
          checkinMinutes: (parseInt(testCheckinTime.split(':')[0]) * 60) + parseInt(testCheckinTime.split(':')[1]),
          workingMinutes: workingMinutes,
          totalCheckoutMinutes: (parseInt(testCheckinTime.split(':')[0]) * 60) + parseInt(testCheckinTime.split(':')[1]) + workingMinutes
        }
      }
    });
  } catch (error) {
    console.error('Error testing checkout calculation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test checkout calculation',
      error: error.message
    });
  }
};

// Get attendance settings with minute details
const getAttendanceSettingsWithDetails = async (req, res) => {
  try {
    const [settings] = await db.query('SELECT * FROM attendance_settings WHERE id = 1');
    
    if (settings.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Attendance settings not found'
      });
    }

    const setting = settings[0];
    const settingsData = typeof setting.settings_data === 'string' 
      ? JSON.parse(setting.settings_data) 
      : setting.settings_data;

    // Parse working hours to minutes for detailed information
    const workingMinutes = parseTimeToMinutes(settingsData.workingHours);
    
    const detailedSettings = {
      ...settingsData,
      workingMinutes: workingMinutes,
      workingHoursFormatted: formatMinutesToTime(workingMinutes),
      workingHoursReadable: formatMinutesToReadable(workingMinutes)
    };

    res.json({
      success: true,
      data: detailedSettings
    });
  } catch (error) {
    console.error('Error fetching attendance settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch attendance settings',
      error: error.message
    });
  }
};

// Manual absent marking for date range (API endpoint)
const manualAbsentMarking = async (req, res) => {
  try {
    const { startDate, endDate } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Both startDate and endDate are required (YYYY-MM-DD format)'
      });
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
      return res.status(400).json({
        success: false,
        message: 'Dates must be in YYYY-MM-DD format'
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format'
      });
    }

    if (start > end) {
      return res.status(400).json({
        success: false,
        message: 'startDate cannot be after endDate'
      });
    }

    const marker = new ManualAbsentMarker();
    const results = await marker.processAbsentMarkingForDateRange(startDate, endDate);

    res.json({
      success: true,
      message: 'Manual absent marking completed successfully',
      data: results
    });

  } catch (error) {
    console.error('Error in manual absent marking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process manual absent marking',
      error: error.message
    });
  }
};

// Manual weekly off records creation for date range (API endpoint)
const manualWeeklyOffRecords = async (req, res) => {
  try {
    const { startDate, endDate, createMissing = true, updateExisting = false, dryRun = false } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Both startDate and endDate are required (YYYY-MM-DD format)'
      });
    }

    // Validate date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
      return res.status(400).json({
        success: false,
        message: 'Dates must be in YYYY-MM-DD format'
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format'
      });
    }

    if (start > end) {
      return res.status(400).json({
        success: false,
        message: 'startDate cannot be after endDate'
      });
    }

    const manager = new ManualWeeklyOffManager();
    const results = await manager.processWeeklyOffForDateRange(startDate, endDate, {
      createMissing,
      updateExisting,
      dryRun
    });

    res.json({
      success: true,
      message: dryRun ? 'Weekly off processing simulation completed' : 'Weekly off records processed successfully',
      data: results,
      dryRun: dryRun
    });

  } catch (error) {
    console.error('Error in manual weekly off processing:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process weekly off records',
      error: error.message
    });
  }
};

// Export all functions
module.exports = {
  getAllEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  sendStaffInvite,
  validateInvitation,
  completeInvitation,
  checkAndSendReminderNotifications,
  triggerReminderManually,
  setupReminderInterval,
  importEmployees,
  upload,
  // New reminder functions
  startReminderScheduler,
  sendCheckinReminder,
  sendDynamicCheckoutReminder,
  manualAutoMarkAbsent,
  manualProcessOvertime,
  testSMS,
  getReminderStatus,
  calculateEmployeeCheckoutTime,
  testCheckoutCalculation,
  getAttendanceSettingsWithDetails,
  reminderScheduler, // Export the scheduler instance for direct access
  // Utility functions for external use
  parseTimeToMinutes,
  formatMinutesToTime,
  formatMinutesToReadable,
  calculateOvertime,
  isWorkingDay,
  manualAbsentMarking,
  manualWeeklyOffRecords
};