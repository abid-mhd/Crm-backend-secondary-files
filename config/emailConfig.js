const nodemailer = require('nodemailer');

const createTransporter = async () => {
  try {
    let transporter;
    
    // Check if Gmail credentials are available
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      // Gmail configuration
      transporter = nodemailer.createTransporter({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });
      
      console.log('Gmail transporter created successfully');
      console.log('Using email:', process.env.EMAIL_USER);
    } else {
      // Fallback to Ethereal for development if credentials not found
      console.warn('Gmail credentials not found, using Ethereal test account');
      const testAccount = await nodemailer.createTestAccount();
      
      transporter = nodemailer.createTransporter({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
      });
      
      console.log('Ethereal test account created:');
      console.log('Email:', testAccount.user);
      console.log('Password:', testAccount.pass);
    }

    // Verify transporter connection
    await transporter.verify();
    console.log('Email server is ready to send messages');
    
    return transporter;
  } catch (error) {
    console.error('Email transporter error:', error);
    throw error;
  }
};

module.exports = createTransporter;