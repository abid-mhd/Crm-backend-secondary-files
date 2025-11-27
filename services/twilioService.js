const twilio = require('twilio');

class TwilioService {
  constructor() {
    // Environment detection
    this.isProduction = process.env.NODE_ENV === 'production';
    
    // Initialize Twilio client only if in production
    if (this.isProduction && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      this.client = twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );
      this.fromNumber = process.env.TWILIO_PHONE_NUMBER;
      console.log('✅ Twilio service initialized for production environment');
    } else {
      this.client = null;
      this.fromNumber = null;
      if (!this.isProduction) {
        console.log('ℹ️ Twilio service disabled - not in production environment');
      } else {
        console.log('⚠️ Twilio service disabled - missing account credentials');
      }
    }
  }

  async sendSMS(to, message) {
    try {
      // Check if we're in production environment
      if (!this.isProduction) {
        console.log(`ℹ️ SMS skipped - not in production environment (NODE_ENV: ${process.env.NODE_ENV})`);
        return { 
          success: true, 
          skipped: true, 
          reason: 'not_production',
          environment: process.env.NODE_ENV,
          message: 'SMS would be sent in production environment'
        };
      }

      // Check if Twilio client is properly initialized
      if (!this.client || !this.fromNumber) {
        console.log('❌ Twilio not properly configured');
        return { 
          success: false, 
          error: 'Twilio not properly configured. Check TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER environment variables.' 
        };
      }

      if (!to || !message) {
        throw new Error('Phone number and message are required');
      }

      // Format phone number (ensure it starts with + and country code)
      const formattedTo = to.startsWith('+') ? to : `+${to}`;

      console.log(`📤 Attempting to send SMS to ${formattedTo} in production environment`);
      console.log(`📝 Message preview: ${message.substring(0, 50)}...`);

      const result = await this.client.messages.create({
        body: message,
        from: this.fromNumber,
        to: formattedTo
      });

      console.log('✅ SMS sent successfully:', result.sid);
      console.log('📊 SMS Status:', result.status);
      
      return { 
        success: true, 
        sid: result.sid,
        status: result.status,
        environment: 'production'
      };
    } catch (error) {
      console.error('❌ Error sending SMS:', error.message);
      
      // Enhanced error handling with specific Twilio error codes
      let errorMessage = error.message;
      
      if (error.code === 21211) {
        errorMessage = 'Invalid phone number format';
      } else if (error.code === 21610) {
        errorMessage = 'Phone number is not SMS capable';
      } else if (error.code === 21408) {
        errorMessage = 'Permission denied for SMS to this number';
      } else if (error.code === 21614) {
        errorMessage = 'Phone number is not a valid mobile number';
      } else if (error.code === 21612) {
        errorMessage = 'Phone number cannot receive SMS messages';
      } else if (error.code === 30007) {
        errorMessage = 'Delivery failed - carrier rejection';
      }
      
      return { 
        success: false, 
        error: errorMessage,
        code: error.code,
        environment: this.isProduction ? 'production' : 'development/staging'
      };
    }
  }

  // Method to send check-in reminder
  async sendCheckInReminder(employeeName, phoneNumber) {
    const message = `Hi ${employeeName}! Reminder: Please check in by 9:00 AM. Have a great day at work!`;
    
    console.log(`⏰ Preparing check-in reminder for ${employeeName}`, {
      phone: phoneNumber,
      environment: this.isProduction ? 'production' : 'development/staging',
      smsEnabled: this.isProduction
    });
    
    return await this.sendSMS(phoneNumber, message);
  }

  // Method to send check-out reminder
  async sendCheckOutReminder(employeeName, phoneNumber) {
    const message = `Hi ${employeeName}! Reminder: Please check out by 6:00 PM. Don't forget to submit your attendance!`;
    
    console.log(`🏃 Preparing check-out reminder for ${employeeName}`, {
      phone: phoneNumber,
      environment: this.isProduction ? 'production' : 'development/staging',
      smsEnabled: this.isProduction
    });
    
    return await this.sendSMS(phoneNumber, message);
  }

  // Method to send general attendance reminder
  async sendAttendanceReminder(employeeName, phoneNumber, type) {
    console.log(`🔔 Preparing ${type} reminder for ${employeeName}`, {
      phone: phoneNumber,
      type: type,
      environment: this.isProduction ? 'production' : 'development/staging',
      smsEnabled: this.isProduction
    });

    if (type === 'checkin') {
      return this.sendCheckInReminder(employeeName, phoneNumber);
    } else if (type === 'checkout') {
      return this.sendCheckOutReminder(employeeName, phoneNumber);
    } else {
      console.log(`❌ Unknown reminder type: ${type}`);
      return { 
        success: false, 
        error: `Unknown reminder type: ${type}` 
      };
    }
  }

  // Method to send custom notification
  async sendCustomNotification(employeeName, phoneNumber, customMessage) {
    console.log(`📨 Preparing custom notification for ${employeeName}`, {
      phone: phoneNumber,
      environment: this.isProduction ? 'production' : 'development/staging',
      smsEnabled: this.isProduction,
      messagePreview: customMessage.substring(0, 50) + '...'
    });
    
    return await this.sendSMS(phoneNumber, customMessage);
  }

  // Method to get service status
  getServiceStatus() {
    return {
      isProduction: this.isProduction,
      twilioConfigured: !!(this.client && this.fromNumber),
      environment: process.env.NODE_ENV || 'development',
      smsEnabled: this.isProduction && !!(this.client && this.fromNumber),
      fromNumber: this.fromNumber ? `${this.fromNumber.substring(0, 6)}...` : 'Not configured'
    };
  }

  // Method to test SMS functionality
  async testSMS(phoneNumber, testMessage = null) {
    const message = testMessage || `Test SMS from Icebergs India HR System. Environment: ${this.isProduction ? 'Production' : 'Development/Staging'}`;
    
    console.log('🧪 Testing SMS functionality:', {
      phone: phoneNumber,
      environment: this.isProduction ? 'production' : 'development/staging',
      smsEnabled: this.isProduction,
      twilioConfigured: !!(this.client && this.fromNumber)
    });

    if (!this.isProduction) {
      return {
        success: true,
        test: true,
        skipped: true,
        reason: 'not_production',
        environment: process.env.NODE_ENV,
        message: 'SMS would be sent in production environment',
        details: {
          phoneNumber: phoneNumber,
          message: message,
          note: 'No actual SMS sent in development/staging environment'
        }
      };
    }

    return await this.sendSMS(phoneNumber, message);
  }
}

module.exports = new TwilioService();