const twilio = require('twilio');

class TwilioService {
  constructor() {
    this.client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    this.fromNumber = process.env.TWILIO_PHONE_NUMBER;
  }

  async sendSMS(to, message) {
    try {
      if (!to || !message) {
        throw new Error('Phone number and message are required');
      }

      // Format phone number (ensure it starts with + and country code)
      const formattedTo = to.startsWith('+') ? to : `+${to}`;

      const result = await this.client.messages.create({
        body: message,
        from: this.fromNumber,
        to: formattedTo
      });

      console.log('SMS sent successfully:', result.sid);
      return { success: true, sid: result.sid };
    } catch (error) {
      console.error('Error sending SMS:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Method to send check-in reminder
  async sendCheckInReminder(employeeName, phoneNumber) {
    const message = `Hi ${employeeName}! Reminder: Please check in by 9:00 AM. Have a great day at work!`;
    return await this.sendSMS(phoneNumber, message);
  }

  // Method to send check-out reminder
  async sendCheckOutReminder(employeeName, phoneNumber) {
    const message = `Hi ${employeeName}! Reminder: Please check out by 6:00 PM. Don't forget to submit your attendance!`;
    return await this.sendSMS(phoneNumber, message);
  }

  // Method to send general attendance reminder
  async sendAttendanceReminder(employeeName, phoneNumber, type) {
    if (type === 'checkin') {
      return this.sendCheckInReminder(employeeName, phoneNumber);
    } else if (type === 'checkout') {
      return this.sendCheckOutReminder(employeeName, phoneNumber);
    }
  }
}

module.exports = new TwilioService();