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

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

class ReminderScheduler {
  constructor() {
    this.isRunning = false;
    this.checkinReminderTime = '8:55'; // Default fallback
    this.checkoutReminderTime = '18:55'; // Default fallback (6:55 PM in 24h format)
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
      
      // Update check-in reminder time from settings
      if (settings.reminderTime && settings.reminderTime.trim() !== '') {
        this.checkinReminderTime = settings.reminderTime;
        console.log(`✅ Check-in reminder time set from settings: ${this.checkinReminderTime}`);
      } else {
        console.log('ℹ️ No reminder time in settings or empty value, using default: 8:55 AM');
        this.checkinReminderTime = '8:55';
      }
      
      // Check-out reminder remains fixed at 6:55 PM
      this.checkoutReminderTime = '18:55';
      
      return {
        checkinReminderTime: this.checkinReminderTime,
        checkoutReminderTime: '5:55 PM'
      };
      
    } catch (error) {
      console.error('Error updating reminder times:', error);
      // Keep default values on error
      this.checkinReminderTime = '8:55';
      this.checkoutReminderTime = '18:55';
      return {
        checkinReminderTime: this.checkinReminderTime,
        checkoutReminderTime: '5:55 PM'
      };
    }
  }

  // Send email reminder
  async sendEmailReminder(employee, reminderType, customMessage = null) {
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
        time = '9:00 AM';
      } else if (reminderType === 'checkout') {
        subject = 'Check-out Reminder - Icebergs India';
        title = 'Check-out Reminder';
        action = 'check out';
        time = '6:00 PM';
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

  async sendReminder(employeeId, reminderType, customMessage = null) {
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
      
      let title = '';
      let message = '';

      if (reminderType === 'checkin') {
        title = 'Check-in Reminder';
        // Ensure message is never empty
        message = customMessage || `Dear ${employee.employeeName}, please remember to check in for work. Check-in time is 10:00 AM.`;
      } else if (reminderType === 'checkout') {
        title = 'Check-out Reminder';
        // Ensure message is never empty
        message = customMessage || `Dear ${employee.employeeName}, please remember to check out. Check-out time is 6:00 PM.`;
      }

      // Validate message is not empty
      if (!message || message.trim() === '') {
        console.error('Error: Message cannot be empty for employee:', employeeId);
        message = `Reminder: Please ${reminderType === 'checkin' ? 'check in' : 'check out'} for work today.`;
      }

      console.log(`📱 Preparing to send ${reminderType} reminder to ${employee.employeeName}:`, {
        phone: employee.phone,
        email: employee.email,
        message: message
      });

      const results = {
        panelNotification: false,
        smsSent: false,
        emailSent: false,
        employeeName: employee.employeeName,
        phone: employee.phone,
        email: employee.email
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

      // Send SMS if phone number exists and is valid
      if (employee.phone && employee.phone.trim() !== '') {
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
        console.log(`ℹ️ No phone number available for ${employee.employeeName}`);
      }

      // Send email reminder
      if (employee.email && employee.email.trim() !== '') {
        try {
          const emailSent = await this.sendEmailReminder(employee, reminderType, customMessage);
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

  // Replace the existing sendSMS method in ReminderScheduler class with this:

async sendSMS(to, message) {
  try {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
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

    // Use the same Twilio client configuration as your OTP code
    const twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN,
      {
        timeout: 120000, // 2 minutes
        region: "us1",
        edge: "ashburn",
      }
    );

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

  // Get employees who haven't checked out
  async getEmployeesWithoutCheckout() {
    try {
      const today = new Date().toISOString().split('T')[0];
      const [employees] = await db.query(`
        SELECT e.* 
        FROM employees e
        WHERE e.active = 1 
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

  // Send check-out reminders
  async sendCheckoutReminders() {
    try {
      console.log('Sending check-out reminders...');
      
      const employees = await this.getEmployeesWithoutCheckout();
      console.log(`Found ${employees.length} employees without check-out`);

      const results = [];
      
      for (const employee of employees) {
        try {
          const result = await this.sendReminder(
            employee.id, 
            'checkout',
            `Dear ${employee.employeeName}, please remember to check out. Check-out time is 6:00 PM.`
          );
          results.push({
            employeeId: employee.id,
            employeeName: employee.employeeName,
            ...result
          });
        } catch (error) {
          console.error(`Failed to send check-out reminder to ${employee.employeeName}:`, error);
          results.push({
            employeeId: employee.id,
            employeeName: employee.employeeName,
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
    const checkinTime = this.parseTimeToCron(this.checkinReminderTime);
    const checkoutTime = this.parseTimeToCron(this.checkoutReminderTime);
    
    return {
      isRunning: this.isRunning,
      checkinReminderTime: this.checkinReminderTime,
      checkoutReminderTime: '5:55 PM',
      checkinCron: `${checkinTime.minutes} ${checkinTime.hours} * * *`,
      checkoutCron: `${checkoutTime.minutes} ${checkoutTime.hours} * * *`,
      checkinFormatted: `${checkinTime.hours}:${checkinTime.minutes.toString().padStart(2, '0')}`,
      checkoutFormatted: `${checkoutTime.hours}:${checkoutTime.minutes.toString().padStart(2, '0')}`
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
    const timeSettings = await this.updateReminderTimes();

    // Parse times for cron
    const checkinTime = this.parseTimeToCron(this.checkinReminderTime);
    const checkoutTime = this.parseTimeToCron(this.checkoutReminderTime);

    console.log('📅 Scheduled times:', {
      checkin: `${checkinTime.hours}:${checkinTime.minutes.toString().padStart(2, '0')} (from settings: ${timeSettings.checkinReminderTime})`,
      checkout: `${checkoutTime.hours}:${checkoutTime.minutes.toString().padStart(2, '0')} (fixed)`
    });

    // Schedule check-in reminder
    cron.schedule(`${checkinTime.minutes} ${checkinTime.hours} * * *`, async () => {
      console.log(`⏰ Running check-in reminder job at ${checkinTime.hours}:${checkinTime.minutes.toString().padStart(2, '0')}`);
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
      console.log(`⏰ Running check-out reminder job at ${checkoutTime.hours}:${checkoutTime.minutes.toString().padStart(2, '0')}`);
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
    console.log('✅ Reminder scheduler started successfully:', status);
    
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

// Create employee
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

    // Insert employee
    const [result] = await connection.query(
      `INSERT INTO employees 
      (employeeName, employeeNo, photo, position, department, email, phone, birthday, location, address, hiredOn, hours) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        hours || null
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

    // Update employee
    await connection.query(
      `UPDATE employees SET 
      employeeName=?, employeeNo=?, photo=?, position=?, department=?, email=?, phone=?, birthday=?, location=?, address=?, hiredOn=?, hours=?
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

// Manual check-out reminder
const sendCheckoutReminder = async (req, res) => {
  try {
    const { employeeId } = req.body;

    if (employeeId) {
      // Send to specific employee
      const result = await reminderScheduler.sendReminder(
        employeeId, 
        'checkout'
      );
      res.json({
        success: true,
        message: 'Check-out reminder sent successfully',
        data: result
      });
    } else {
      // Send to all employees without check-out
      const results = await reminderScheduler.sendCheckoutReminders();
      res.json({
        success: true,
        message: 'Check-out reminders sent successfully',
        data: results
      });
    }
  } catch (error) {
    console.error('Error sending check-out reminder:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send check-out reminder'
    });
  }
};

// Test SMS
const testSMS = async (req, res) => {
  try {
    const { phone, message } = req.body;
    
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
const getReminderStatusInternal = async () => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Get employees without check-in
    const employeesWithoutCheckin = await reminderScheduler.getEmployeesWithoutCheckin();
    
    // Get employees without check-out
    const employeesWithoutCheckout = await reminderScheduler.getEmployeesWithoutCheckout();
    
    // Get scheduler status with actual times
    const schedulerStatus = reminderScheduler.getSchedulerStatus();
    
    return {
      success: true,
      data: {
        schedulerRunning: reminderScheduler.isRunning,
        date: today,
        employeesWithoutCheckin: employeesWithoutCheckin.length,
        employeesWithoutCheckout: employeesWithoutCheckout.length,
        checkinReminderTime: schedulerStatus.checkinReminderTime,
        checkoutReminderTime: schedulerStatus.checkoutReminderTime,
        actualSchedule: {
          checkin: schedulerStatus.checkinFormatted,
          checkout: schedulerStatus.checkoutFormatted
        },
        totalActiveEmployees: employeesWithoutCheckin.length + employeesWithoutCheckout.length
      }
    };
  } catch (error) {
    console.error('Error getting reminder status:', error);
    return {
      success: false,
      message: 'Failed to get reminder status',
      error: error.message
    };
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
  sendCheckoutReminder,
  testSMS,
  // getReminderStatus
};