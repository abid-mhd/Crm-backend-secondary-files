const db = require('../config/db');
const NotificationService = require('../services/notificationService');
const twilio = require('twilio');
const nodemailer = require('nodemailer');

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

class EmployeeRequestController {
  constructor() {
    // Environment detection
    this.isProduction = process.env.NODE_ENV === 'production';
    console.log(`🔧 Employee Request Controller initialized in ${this.isProduction ? 'production' : 'development/staging'} mode`);
  }
  
  // Get employee ID from authenticated user
  async getEmployeeId(req) {
    console.log('Request user in getEmployeeId:', req.user);
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
  }

  // Get overdue records for employee
  async getMyOverdueRecords(req, res) {
    try {
      const employeeId = await this.getEmployeeId(req);
      console.log("Employee ID:", employeeId);
      
      if (!employeeId) {
        return res.status(400).json({
          success: false,
          message: 'Employee ID not found in user data'
        });
      }

      // Get overdue records
      const [overdueRecords] = await db.query(`
        SELECT 
          a.id as attendance_id,
          DATE(a.date) as date,
          a.status,
          a.check_in,
          a.check_out,
          a.remarks,
          a.created_at
        FROM attendance a
        WHERE a.employee_id = ?
          AND a.status = 'Absent'
          AND DATE(a.date) >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
          AND DATE(a.date) < CURDATE()
          AND a.check_out IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM employee_requests er 
            WHERE er.employee_id = ? 
            AND DATE(er.request_date) = DATE(a.date)
            AND er.request_type = 'unmark_absent'
            AND er.status IN ('pending', 'approved')
          )
        ORDER BY a.date DESC
      `, [employeeId, employeeId]);

      res.json({
        success: true,
        data: overdueRecords,
        message: overdueRecords.length > 0 ? 'Overdue records found' : 'No overdue records found'
      });

    } catch (error) {
      console.error('Error fetching overdue records:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch overdue records',
        error: error.message
      });
    }
  }

  // Create unmark absent request
  async createUnmarkAbsentRequest(req, res) {
    try {
      const employeeId = await this.getEmployeeId(req);
      const { request_date, reason, supporting_document } = req.body;

      if (!employeeId) {
        return res.status(400).json({
          success: false,
          message: 'Employee ID not found in user data'
        });
      }

      // Validate required fields
      if (!request_date || !reason) {
        return res.status(400).json({
          success: false,
          message: 'Request date and reason are required'
        });
      }

      // Convert ISO date to YYYY-MM-DD format
      let formattedDate;
      try {
        if (request_date.includes('T')) {
          const dateObj = new Date(request_date);
          formattedDate = dateObj.toISOString().split('T')[0];
        } else {
          formattedDate = request_date;
        }
        console.log('Date conversion:', { original: request_date, formatted: formattedDate });
      } catch (dateError) {
        console.error('Error formatting date:', dateError);
        return res.status(400).json({
          success: false,
          message: 'Invalid date format. Please use YYYY-MM-DD format.'
        });
      }

      // Check if the requested date is today (should not be allowed)
      const today = new Date().toISOString().split('T')[0];
      if (formattedDate === today) {
        return res.status(400).json({
          success: false,
          message: 'Cannot create unmark absent request for current date. Please wait until tomorrow.'
        });
      }

      // Find the specific attendance record
      const [attendanceRecords] = await db.query(`
        SELECT 
          id, 
          date as original_date,
          DATE(date) as date_only,
          status,
          check_in,
          check_out
        FROM attendance 
        WHERE employee_id = ?
          AND DATE(date) = DATE(?)
          AND status = 'Absent'
          AND check_out IS NULL
      `, [employeeId, formattedDate]);

      if (attendanceRecords.length === 0) {
        return res.status(400).json({
          success: false,
          message: `No absent record found for ${formattedDate}.`
        });
      }

      const attendanceId = attendanceRecords[0].id;

      // Check if pending request already exists
      const [existingRequests] = await db.query(`
        SELECT id FROM employee_requests 
        WHERE employee_id = ? 
        AND DATE(request_date) = DATE(?)
        AND request_type = 'unmark_absent'
        AND status = 'pending'
      `, [employeeId, formattedDate]);

      // if (existingRequests.length > 0) {
      //   return res.status(400).json({
      //     success: false,
      //     message: 'Pending request already exists for this date'
      //   });
      // }

      // Get employee details
      const [employees] = await db.query(`
        SELECT e.*, u.id as user_id 
        FROM employees e 
        LEFT JOIN users u ON e.id = u.employee_id 
        WHERE e.id = ?
      `, [employeeId]);

      if (employees.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Employee not found'
        });
      }

      const employee = employees[0];

      // Insert request
      const [result] = await db.query(`
        INSERT INTO employee_requests 
        (employee_id, request_type, request_date, reason, status, attendance_id, created_at, updated_at)
        VALUES (?, 'unmark_absent', ?, ?, 'pending', ?, NOW(), NOW())
      `, [employeeId, formattedDate, reason, attendanceId]);

      const requestId = result.insertId;

      // Send notifications
      await this.notifyHRAndAdminsComprehensive(employee, formattedDate, reason, requestId);
      await this.notifyEmployeeRequestSubmitted(employee, formattedDate, reason, requestId);

      res.json({
        success: true,
        message: 'Request submitted successfully and notifications sent',
        data: {
          requestId: requestId,
          requestDate: formattedDate,
          status: 'pending'
        },
        environment: this.isProduction ? 'production' : 'development/staging'
      });

    } catch (error) {
      console.error('Error creating unmark absent request:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to submit request',
        error: error.message
      });
    }
  }

async createNewRequest(req, res) {
  try {
    const employeeId = await this.getEmployeeId(req);
    const { request_type, request_date, reason } = req.body;
    const supporting_document = req.file; // From multer

    if (!employeeId) {
      return res.status(400).json({
        success: false,
        message: 'Employee ID not found in user data'
      });
    }

    // Validate required fields
    if (!request_type || !request_date || !reason) {
      return res.status(400).json({
        success: false,
        message: 'Request type, date, and reason are required'
      });
    }

    // Validate request type
    const validRequestTypes = ['leave_approval', 'work_from_home', 'unmark_absent'];
    if (!validRequestTypes.includes(request_type)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request type'
      });
    }

    // Convert ISO date to YYYY-MM-DD format
    let formattedDate;
    try {
      if (request_date.includes('T')) {
        const dateObj = new Date(request_date);
        formattedDate = dateObj.toISOString().split('T')[0];
      } else {
        formattedDate = request_date;
      }
    } catch (dateError) {
      console.error('Error formatting date:', dateError);
      return res.status(400).json({
        success: false,
        message: 'Invalid date format. Please use YYYY-MM-DD format.'
      });
    }

    // Check if request date is in the past (only for unmark_absent)
    const today = new Date().toISOString().split('T')[0];
    if (request_type === 'unmark_absent' && formattedDate >= today) {
      return res.status(400).json({
        success: false,
        message: 'Unmark absent requests can only be made for past dates'
      });
    }

    // Check if pending request already exists for the same date and type
    const [existingRequests] = await db.query(`
      SELECT id FROM employee_requests 
      WHERE employee_id = ? 
      AND DATE(request_date) = DATE(?)
      AND request_type = ?
      AND status = 'pending'
    `, [employeeId, formattedDate, request_type]);

    if (existingRequests.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Pending ${request_type.replace('_', ' ')} request already exists for this date`
      });
    }

    // Get employee details
    const [employees] = await db.query(`
      SELECT e.*, u.id as user_id 
      FROM employees e 
      LEFT JOIN users u ON e.id = u.employee_id 
      WHERE e.id = ?
    `, [employeeId]);

    if (employees.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    const employee = employees[0];

    // Handle file upload - Use multer's saved file path
    let documentPath = null;
    if (supporting_document) {
      const path = require('path');
      
      // Extract the relative path from the full path
      const fullPath = supporting_document.path;
      const projectRoot = path.join(__dirname, '..', '..');
      
     documentPath = `uploads/requests/${supporting_document.filename}`;
      
      console.log('File saved as:', {
        original: fullPath,
        stored: documentPath,
        filename: supporting_document.filename
      });
    }

    // Insert request
    const [result] = await db.query(`
      INSERT INTO employee_requests 
      (employee_id, request_type, request_date, reason, supporting_document, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', NOW(), NOW())
    `, [employeeId, request_type, formattedDate, reason, documentPath]);

    const requestId = result.insertId;

    // Send notifications
    await this.notifyHRAndAdminsComprehensive(employee, formattedDate, reason, requestId, request_type);
    await this.notifyEmployeeRequestSubmitted(employee, formattedDate, reason, requestId, request_type);

    res.json({
      success: true,
      message: `${request_type.replace('_', ' ')} request submitted successfully and notifications sent`,
      data: {
        requestId: requestId,
        requestType: request_type,
        requestDate: formattedDate,
        status: 'pending',
        supportingDocument: documentPath
      },
      environment: this.isProduction ? 'production' : 'development/staging'
    });

  } catch (error) {
    console.error('Error creating new request:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit request',
      error: error.message,
      stack: this.isProduction ? null : error.stack
    });
  }
}

async notifyHRAndAdminsComprehensive(employee, requestDate, reason, requestId, requestType = 'unmark_absent') {
  try {
    console.log(`🔔 Starting comprehensive HR/Admin notification for ${requestType} request ${requestId}`, {
      environment: this.isProduction ? 'production' : 'development/staging',
      smsEnabled: this.isProduction
    });
    
    // Get all HR and Admin users
    const [hrAdmins] = await db.query(`
      SELECT u.* 
      FROM users u 
      WHERE u.role IN ('hr', 'admin') 
      AND u.email IS NOT NULL
    `);

    if (hrAdmins.length === 0) {
      console.log('No active HR/Admin users found for notification');
      return;
    }

    console.log(`Found ${hrAdmins.length} HR/Admin users to notify`);

    const requestTypeText = this.getRequestTypeText(requestType);
    const notificationPromises = [];

    // Send notifications to each HR/Admin
    for (const user of hrAdmins) {
      const userNotificationPromises = [];

      // Panel notification for HR/Admin
      userNotificationPromises.push(
        NotificationService.createNotification({
          userIds: [user.id],
          title: `New ${requestTypeText} Request`,
          message: `${employee.employeeName} submitted a ${requestTypeText.toLowerCase()} request for ${requestDate}. Reason: ${reason.substring(0, 100)}...`,
          type: 'employee_request',
          module: 'attendance',
          moduleId: requestId
        }).catch(err => console.error(`Panel notification error for user ${user.id}:`, err))
      );

      // Email notification to HR/Admin
      userNotificationPromises.push(
        this.sendRequestEmailToHR(user, employee, requestDate, reason, requestId, requestType)
          .catch(err => console.error(`Email error for user ${user.id}:`, err))
      );

      // SMS notification to HR/Admin if phone exists and in production
      if (user.phone && this.isProduction) {
        userNotificationPromises.push(
          this.sendRequestSMSToHR(user, employee, requestDate, reason, requestId, requestType)
            .catch(err => console.error(`SMS error for user ${user.id}:`, err))
        );
      } else if (user.phone && !this.isProduction) {
        console.log(`ℹ️ SMS skipped for HR/Admin user ${user.id} - not in production environment`);
        userNotificationPromises.push(Promise.resolve({ type: 'sms', success: true, skipped: 'not_production' }));
      }

      // Execute all notifications for this user
      notificationPromises.push(
        Promise.allSettled(userNotificationPromises).then(results => {
          const successful = results.filter(result => result.status === 'fulfilled').length;
          const failed = results.filter(result => result.status === 'rejected').length;
          console.log(`User ${user.id} notifications: ${successful} successful, ${failed} failed`);
          return { userId: user.id, successful, failed };
        })
      );
    }

    // Wait for all user notifications to complete
    const allResults = await Promise.allSettled(notificationPromises);
    
    const totalSuccessful = allResults.reduce((sum, result) => {
      if (result.status === 'fulfilled') {
        return sum + result.value.successful;
      }
      return sum;
    }, 0);
    
    const totalFailed = allResults.reduce((sum, result) => {
      if (result.status === 'fulfilled') {
        return sum + result.value.failed;
      }
      return sum;
    }, 0);

    console.log(`✅ HR/Admin notifications completed for ${requestType} request ${requestId}: ${totalSuccessful} successful, ${totalFailed} failed`);

    return {
      totalHRAdmins: hrAdmins.length,
      totalNotifications: totalSuccessful + totalFailed,
      successful: totalSuccessful,
      failed: totalFailed,
      environment: this.isProduction ? 'production' : 'development/staging',
      smsEnabled: this.isProduction
    };

  } catch (error) {
    console.error('❌ Error in comprehensive HR/Admin notification:', error);
    throw error;
  }
}

// HELPER METHOD TO GET REQUEST TYPE TEXT
getRequestTypeText(requestType) {
  const typeMap = {
    'unmark_absent': 'Unmark Absent',
    'leave_approval': 'Leave Approval',
    'work_from_home': 'Work From Home'
  };
  return typeMap[requestType] || 'Request';
}

  // NOTIFY EMPLOYEE ABOUT REQUEST SUBMISSION
async notifyEmployeeRequestSubmitted(employee, requestDate, reason, requestId, requestType = 'unmark_absent') {
  try {
    console.log(`🔔 Notifying employee about ${requestType} request submission ${requestId}`, {
      environment: this.isProduction ? 'production' : 'development/staging',
      smsEnabled: this.isProduction
    });
    
    if (!employee.user_id) {
      console.log('No user ID found for employee, skipping submission notification');
      return;
    }

    const requestTypeText = this.getRequestTypeText(requestType);

    const notificationPromises = [];

    // Panel notification for employee
    notificationPromises.push(
      NotificationService.createNotification({
        userIds: [employee.user_id],
        title: `${requestTypeText} Request Submitted`,
        message: `Your ${requestTypeText.toLowerCase()} request for ${requestDate} has been submitted and is under review.`,
        type: 'employee_request',
        module: 'attendance',
        moduleId: requestId
      }).catch(err => console.error(`Employee panel notification error:`, err))
    );

    // Email notification to employee
    notificationPromises.push(
      this.sendRequestSubmissionEmailToEmployee(employee, requestDate, reason, requestId, requestType)
        .catch(err => console.error(`Employee email error:`, err))
    );

    // SMS notification to employee if phone exists and in production
    if (employee.phone && this.isProduction) {
      notificationPromises.push(
        this.sendRequestSubmissionSMSToEmployee(employee, requestDate, reason, requestId, requestType)
          .catch(err => console.error(`Employee SMS error:`, err))
      );
    } else if (employee.phone && !this.isProduction) {
      console.log(`ℹ️ SMS skipped for employee ${employee.employeeName} - not in production environment`);
      notificationPromises.push(Promise.resolve({ type: 'sms', success: true, skipped: 'not_production' }));
    }

    // Execute all notification promises
    const results = await Promise.allSettled(notificationPromises);
    
    const successful = results.filter(result => result.status === 'fulfilled').length;
    const failed = results.filter(result => result.status === 'rejected').length;
    
    console.log(`✅ Employee submission notifications completed for ${requestType} request ${requestId}: ${successful} successful, ${failed} failed`);

  } catch (error) {
    console.error('❌ Error notifying employee about request submission:', error);
  }
}

// SEND EMAIL TO HR/ADMIN ABOUT NEW REQUEST
async sendRequestEmailToHR(user, employee, requestDate, reason, requestId, requestType = 'unmark_absent') {
  try {
    if (!user.email) {
      console.log(`No email address for HR/Admin user ${user.id}`);
      return;
    }

    const staffPortalLink = process.env.FRONTEND_URL || 'http://16.16.110.203';
    const adminLink = `${staffPortalLink}/admin/employee-requests`;
    const requestTypeText = this.getRequestTypeText(requestType);

    const emailHtml = `<!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; background: #f7f7fb; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 30px; }
        .alert { background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 15px; margin: 20px 0; }
        .button { display: inline-block; background: #091D78; color: #fff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: bold; }
        .details { background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2 style="color: #091D78;">${requestTypeText} Request</h2>
        </div>
        
        <div class="alert">
          <strong>Action Required:</strong> New ${requestTypeText.toLowerCase()} request requires your review.
        </div>
        
        <div class="details">
          <h3>Request Details:</h3>
          <p><strong>Employee:</strong> ${employee.employeeName} (${employee.employeeNo})</p>
          <p><strong>Request Type:</strong> ${requestTypeText}</p>
          <p><strong>Request Date:</strong> ${requestDate}</p>
          <p><strong>Reason:</strong> ${reason}</p>
          <p><strong>Request ID:</strong> #${requestId}</p>
          <p><strong>Submitted:</strong> ${new Date().toLocaleDateString()}</p>
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${adminLink}" class="button">Review Request</a>
        </div>
        
        <p style="color: #666; font-size: 14px;">
          This is an automated notification. Please do not reply to this email.
        </p>
      </div>
    </body>
    </html>`;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: `"Icebergs India - HR System" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: `${requestTypeText} Request - ${employee.employeeName}`,
      html: emailHtml
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ ${requestTypeText} email notification sent to HR/Admin ${user.email}`);

  } catch (error) {
    console.error('❌ Error sending email notification to HR/Admin:', error);
    throw error;
  }
}


// SEND SMS TO HR/ADMIN ABOUT NEW REQUEST
async sendRequestSMSToHR(user, employee, requestDate, reason, requestId, requestType = 'unmark_absent') {
  try {
    // Only send SMS in production environment
    if (!this.isProduction) {
      console.log(`ℹ️ HR/Admin SMS skipped for user ${user.id} - not in production environment`);
      return { skipped: true, reason: 'not_production' };
    }

    if (!user.phone || !twilioClient) {
      console.log(`No phone number or Twilio not configured for HR/Admin user ${user.id}`);
      return;
    }

    const cleanPhone = user.phone.replace(/[^\d+]/g, '');
    const formattedPhone = `+91${cleanPhone}`;
    const requestTypeText = this.getRequestTypeText(requestType);

    const message = `New ${requestTypeText} Request from ${employee.employeeName} for ${requestDate}. Reason: ${reason.substring(0, 50)}... Request ID: ${requestId}. Please review in admin panel.`;

    const messageOptions = {
      body: message,
      to: formattedPhone
    };

    // Use Messaging Service SID if available, otherwise use phone number
    if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
      messageOptions.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    } else if (process.env.TWILIO_PHONE_NUMBER) {
      messageOptions.from = process.env.TWILIO_PHONE_NUMBER;
    } else {
      console.log('Twilio not properly configured for SMS');
      return;
    }

    await twilioClient.messages.create(messageOptions);
    console.log(`✅ ${requestTypeText} SMS notification sent to HR/Admin ${formattedPhone}`);

  } catch (error) {
    console.error('❌ Error sending SMS to HR/Admin:', error);
    throw error;
  }
}

// SEND EMAIL TO EMPLOYEE ABOUT REQUEST SUBMISSION
async sendRequestSubmissionEmailToEmployee(employee, requestDate, reason, requestId, requestType = 'unmark_absent') {
  try {
    if (!employee.email) {
      console.log(`No email address for employee ${employee.employeeName}`);
      return;
    }

    const staffPortalLink = process.env.FRONTEND_URL || 'http://16.16.110.203';
    const employeeLink = `${staffPortalLink}/employee/requests`;
    const requestTypeText = this.getRequestTypeText(requestType);

    const emailHtml = `<!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; background: #f7f7fb; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 30px; }
        .success { background: #d4edda; border: 1px solid #c3e6cb; border-radius: 6px; padding: 15px; margin: 20px 0; color: #155724; }
        .button { display: inline-block; background: #091D78; color: #fff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: bold; }
        .details { background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2 style="color: #091D78;">${requestTypeText} Request Submitted</h2>
        </div>
        
        <div class="success">
          <strong>Request Received:</strong> Your ${requestTypeText.toLowerCase()} request has been submitted successfully.
        </div>
        
        <div class="details">
          <h3>Request Details:</h3>
          <p><strong>Request Type:</strong> ${requestTypeText}</p>
          <p><strong>Request Date:</strong> ${requestDate}</p>
          <p><strong>Reason:</strong> ${reason}</p>
          <p><strong>Request ID:</strong> #${requestId}</p>
          <p><strong>Status:</strong> Pending Review</p>
          <p><strong>Submitted:</strong> ${new Date().toLocaleDateString()}</p>
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${employeeLink}" class="button">View My Requests</a>
        </div>
        
        <p style="color: #666; font-size: 14px;">
          You will be notified when your request is reviewed by HR/Admin.
        </p>
      </div>
    </body>
    </html>`;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: `"Icebergs India - HR System" <${process.env.EMAIL_USER}>`,
      to: employee.email,
      subject: `${requestTypeText} Request Submitted - ${requestDate}`,
      html: emailHtml
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ ${requestTypeText} submission email sent to employee ${employee.email}`);

  } catch (error) {
    console.error('❌ Error sending submission email to employee:', error);
    throw error;
  }
}

// SEND SMS TO EMPLOYEE ABOUT REQUEST SUBMISSION
async sendRequestSubmissionSMSToEmployee(employee, requestDate, reason, requestId, requestType = 'unmark_absent') {
  try {
    // Only send SMS in production environment
    if (!this.isProduction) {
      console.log(`ℹ️ Employee submission SMS skipped for ${employee.employeeName} - not in production environment`);
      return { skipped: true, reason: 'not_production' };
    }

    if (!employee.phone || !twilioClient) {
      console.log(`No phone number or Twilio not configured for employee ${employee.employeeName}`);
      return;
    }

    const cleanPhone = employee.phone.replace(/[^\d+]/g, '');
    const formattedPhone = `+91${cleanPhone}`;
    const requestTypeText = this.getRequestTypeText(requestType);

    const message = `Your ${requestTypeText.toLowerCase()} request for ${requestDate} has been submitted successfully. Request ID: ${requestId}. Status: Pending Review. You will be notified of the decision.`;

    const messageOptions = {
      body: message,
      to: formattedPhone
    };

    if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
      messageOptions.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    } else if (process.env.TWILIO_PHONE_NUMBER) {
      messageOptions.from = process.env.TWILIO_PHONE_NUMBER;
    } else {
      console.log('Twilio not properly configured for SMS');
      return;
    }

    await twilioClient.messages.create(messageOptions);
    console.log(`✅ ${requestTypeText} submission SMS sent to employee ${formattedPhone}`);

  } catch (error) {
    console.error('❌ Error sending submission SMS to employee:', error);
    throw error;
  }
}

  // Get my requests (for employee)
  async getMyRequests(req, res) {
    try {
      const employeeId = await this.getEmployeeId(req);

      if (!employeeId) {
        return res.status(400).json({
          success: false,
          message: 'Employee ID not found in user data'
        });
      }

      const [requests] = await db.query(`
        SELECT 
          er.*,
          a.status as original_status,
          u.name as reviewed_by_name
        FROM employee_requests er
        LEFT JOIN attendance a ON er.employee_id = a.employee_id AND er.request_date = a.date
        LEFT JOIN users u ON er.handled_by = u.id
        WHERE er.employee_id = ?
        ORDER BY er.created_at DESC
      `, [employeeId]);

      res.json({
        success: true,
        data: requests,
        message: 'Requests fetched successfully'
      });

    } catch (error) {
      console.error('Error fetching requests:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch requests',
        error: error.message
      });
    }
  }

  async getAllRequests(req, res) {
  try {
    const { page = 1, limit = 10, status = 'all' } = req.query;
    const offset = (page - 1) * limit;

    let whereClause = '';
    let queryParams = [parseInt(limit), parseInt(offset)];

    if (status !== 'all') {
      whereClause = 'WHERE er.status = ?';
      queryParams = [status, parseInt(limit), parseInt(offset)];
    }

    const [requests] = await db.query(`
      SELECT 
        er.*,
        e.employeeName,
        e.employeeNo,
        e.position,
        e.department,
        u.name as reviewed_by_name
      FROM employee_requests er
      INNER JOIN employees e ON er.employee_id = e.id
      LEFT JOIN users u ON er.handled_by = u.id
      ${whereClause}
      ORDER BY er.created_at DESC
      LIMIT ? OFFSET ?
    `, queryParams);

    // Get total count
    let countQuery = 'SELECT COUNT(*) as total FROM employee_requests er';
    let countParams = [];
    
    if (status !== 'all') {
      countQuery += ' WHERE er.status = ?';
      countParams = [status];
    }

    const [totalCount] = await db.query(countQuery, countParams);

    res.json({
      success: true,
      data: {
        requests: requests,
        total: totalCount[0].total,
        page: parseInt(page),
        limit: parseInt(limit)
      },
      message: 'Requests fetched successfully'
    });

  } catch (error) {
    console.error('Error fetching requests:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch requests',
      error: error.message
    });
  }
}

  // Get all pending requests (for HR/Admin)
async getAllPendingRequests(req, res) {
  try {
    const { page = 1, limit = 5 } = req.query;
    const offset = (page - 1) * limit;

    const [requests] = await db.query(`
      SELECT 
        er.*,
        e.employeeName,
        e.employeeNo,
        e.position,
        e.department,
        u.name as reviewed_by_name
      FROM employee_requests er
      INNER JOIN employees e ON er.employee_id = e.id
      LEFT JOIN users u ON er.handled_by = u.id
      WHERE er.status = 'pending'
      ORDER BY er.created_at DESC
      LIMIT ? OFFSET ?
    `, [parseInt(limit), parseInt(offset)]);

    // Get total count
    const [totalCount] = await db.query(`
      SELECT COUNT(*) as total 
      FROM employee_requests 
      WHERE status = 'pending'
    `);

    res.json({
      success: true,
      data: {
        requests: requests,
        total: totalCount[0].total,
        page: parseInt(page),
        limit: parseInt(limit)
      },
      message: 'Pending requests fetched successfully'
    });

  } catch (error) {
    console.error('Error fetching pending requests:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending requests',
      error: error.message
    });
  }
}

// Update request status (for HR/Admin)
async updateRequestStatus(req, res) {
  try {
    const { requestId } = req.params;
    const { status, review_notes } = req.body;
    const reviewedBy = req.user.id;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be "approved" or "rejected"'
      });
    }

    // Get request details with employee information
    const [requests] = await db.query(`
      SELECT er.*, e.*, u.id as employee_user_id
      FROM employee_requests er
      INNER JOIN employees e ON er.employee_id = e.id
      LEFT JOIN users u ON e.id = u.employee_id
      WHERE er.id = ?
    `, [requestId]);

    if (requests.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Request not found'
      });
    }

    const request = requests[0];
    const employee = {
      id: request.employee_id,
      employeeName: request.employeeName,
      employeeNo: request.employeeNo,
      email: request.email,
      phone: request.phone,
      user_id: request.employee_user_id
    };

    // Check if request is already processed (NOT pending)
    if (request.status == 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Request has already been processed'
      });
    }

    let connection;
    try {
      connection = await db.getConnection();
      await connection.beginTransaction();

      // Update request status
      await connection.query(`
        UPDATE employee_requests 
        SET status = ?, admin_remarks = ?, handled_by = ?, handled_at = NOW(), updated_at = NOW()
        WHERE id = ?
      `, [status, review_notes || null, reviewedBy, requestId]);

      // If approved, handle different request types
      if (status === 'approved') {
        await this.handleApprovedRequest(connection, request, requestId);
      }

      await connection.commit();

      // Notify employee about the decision
      await this.notifyEmployeeDecisionComprehensive(employee, request, status, review_notes, request.request_type);

      res.json({
        success: true,
        message: `Request ${status} successfully`,
        data: {
          requestId: requestId,
          status: status,
          updatedAt: new Date()
        },
        environment: this.isProduction ? 'production' : 'development/staging'
      });

    } catch (error) {
      if (connection) await connection.rollback();
      console.error('Transaction error:', error);
      throw error;
    } finally {
      if (connection) connection.release();
    }

  } catch (error) {
    console.error('Error updating request status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update request status',
      error: error.message
    });
  }
}

// Handle approved requests based on type
async handleApprovedRequest(connection, request, requestId) {
  const requestType = request.request_type;
  
  switch (requestType) {
    case 'unmark_absent':
      await this.handleUnmarkAbsentApproval(connection, request, requestId);
      break;
    
    case 'work_from_home':
      await this.handleWorkFromHomeApproval(connection, request, requestId);
      break;
    
    case 'leave_approval':
      await this.handleLeaveApproval(connection, request, requestId);
      break;
    
    default:
      console.log(`No specific handling for request type: ${requestType}`);
  }
}

// Handle unmark_absent approval
async handleUnmarkAbsentApproval(connection, request, requestId) {
  // Get attendance settings to calculate checkout time
  const [attendanceSettings] = await connection.query(`
    SELECT settings_data FROM attendance_settings ORDER BY id LIMIT 1
  `);

  let workingHours = '09:00'; // Default working hours
  
  if (attendanceSettings.length > 0 && attendanceSettings[0].settings_data) {
    try {
      const settingsData = typeof attendanceSettings[0].settings_data === 'string' 
        ? JSON.parse(attendanceSettings[0].settings_data) 
        : attendanceSettings[0].settings_data;
      
      if (settingsData.workingHours) {
        workingHours = settingsData.workingHours;
      }
    } catch (parseError) {
      console.error('Error parsing settings_data JSON:', parseError);
      // Use default working hours if JSON parsing fails
    }
  }

  console.log('Using working hours:', workingHours);

  // Parse working hours (format: "HH:MM")
  const [workHours, workMinutes] = workingHours.split(':').map(Number);
  const totalWorkMinutes = workHours * 60 + workMinutes;

  // First, find the attendance record for this employee and date
  const [attendanceRecords] = await connection.query(`
    SELECT id, check_in FROM attendance 
    WHERE employee_id = ? AND DATE(date) = DATE(?)
  `, [request.employee_id, request.request_date]);

  if (attendanceRecords.length > 0) {
    const attendanceRecord = attendanceRecords[0];
    let checkoutTime = null;

    // Calculate checkout time based on check_in time and working hours
    if (attendanceRecord.check_in) {
      // Parse check_in time (format: "HH:MM:SS")
      const [checkInHours, checkInMinutes, checkInSeconds] = attendanceRecord.check_in.split(':').map(Number);
      
      // Calculate checkout time by adding working hours to check_in time
      const totalCheckInMinutes = checkInHours * 60 + checkInMinutes;
      const totalCheckoutMinutes = totalCheckInMinutes + totalWorkMinutes;
      
      // Convert back to hours and minutes
      const checkoutHours = Math.floor(totalCheckoutMinutes / 60);
      const checkoutMinutes = totalCheckoutMinutes % 60;
      
      // Format checkout time as HH:MM:SS
      checkoutTime = `${checkoutHours.toString().padStart(2, '0')}:${checkoutMinutes.toString().padStart(2, '0')}:00`;
      
      console.log(`Checkout calculation: ${attendanceRecord.check_in} + ${workingHours} = ${checkoutTime}`);
    } else {
      // If no check_in time, set default checkout time based on working hours
      const defaultCheckIn = '10:00:00';
      const [checkInHours, checkInMinutes] = defaultCheckIn.split(':').map(Number);
      const totalCheckInMinutes = checkInHours * 60 + checkInMinutes;
      const totalCheckoutMinutes = totalCheckInMinutes + totalWorkMinutes;
      
      const checkoutHours = Math.floor(totalCheckoutMinutes / 60);
      const checkoutMinutes = totalCheckoutMinutes % 60;
      checkoutTime = `${checkoutHours.toString().padStart(2, '0')}:${checkoutMinutes.toString().padStart(2, '0')}:00`;
      
      console.log(`Default checkout calculation: ${defaultCheckIn} + ${workingHours} = ${checkoutTime}`);
    }

    // Update existing attendance record with checkout time
    await connection.query(`
      UPDATE attendance 
      SET status = 'Present', 
          check_out = ?,
          remarks = CONCAT(IFNULL(remarks, ''), ' Absent regularized via request #${requestId}'),
          updated_at = NOW()
      WHERE id = ?
    `, [checkoutTime, attendanceRecord.id]);

    console.log(`Updated attendance record ${attendanceRecord.id} with checkout time: ${checkoutTime}`);

  } else {
    // Create new attendance record if not exists
    const defaultCheckIn = '10:00:00'; // Default check-in time
    
    // Calculate checkout time for default check-in
    const [checkInHours, checkInMinutes] = defaultCheckIn.split(':').map(Number);
    const totalCheckInMinutes = checkInHours * 60 + checkInMinutes;
    const totalCheckoutMinutes = totalCheckInMinutes + totalWorkMinutes;
    
    const checkoutHours = Math.floor(totalCheckoutMinutes / 60);
    const checkoutMinutes = totalCheckoutMinutes % 60;
    const checkoutTime = `${checkoutHours.toString().padStart(2, '0')}:${checkoutMinutes.toString().padStart(2, '0')}:00`;

    await connection.query(`
      INSERT INTO attendance 
      (employee_id, date, status, check_in, check_out, remarks, created_at, updated_at)
      VALUES (?, ?, 'Present', ?, ?, 'Absent regularized via request #${requestId}', NOW(), NOW())
    `, [request.employee_id, request.request_date, defaultCheckIn, checkoutTime]);

    console.log(`Created new attendance record with check_in: ${defaultCheckIn}, check_out: ${checkoutTime}`);
  }
}

// Handle work_from_home approval
async handleWorkFromHomeApproval(connection, request, requestId) {
  // Check if attendance record already exists for this date
  const [attendanceRecords] = await connection.query(`
    SELECT id FROM attendance 
    WHERE employee_id = ? AND DATE(date) = DATE(?)
  `, [request.employee_id, request.request_date]);

  if (attendanceRecords.length > 0) {
    // Update existing record - ONLY work_from_home and work_from_home_request_id columns
    await connection.query(`
      UPDATE attendance 
      SET work_from_home = 1,
          work_from_home_request_id = ?,
          remarks = CONCAT(IFNULL(remarks, ''), ' Work from home approved via request #${requestId}'),
          updated_at = NOW()
      WHERE id = ?
    `, [requestId, attendanceRecords[0].id]);
    
    console.log(`Updated existing attendance record with work from home for request #${requestId}`);
  } else {
    // Create new attendance record with work from home flags
    await connection.query(`
      INSERT INTO attendance 
      (employee_id, date, work_from_home, work_from_home_request_id, remarks, created_at, updated_at)
      VALUES (?, ?, 1, ?, 'Work from home approved via request #${requestId}', NOW(), NOW())
    `, [request.employee_id, request.request_date, requestId]);
    
    console.log(`Created new work from home attendance record for request #${requestId}`);
  }
}

// Handle leave_approval approval
async handleLeaveApproval(connection, request, requestId) {
  // Check if attendance record already exists for this date
  const [attendanceRecords] = await connection.query(`
    SELECT id FROM attendance 
    WHERE employee_id = ? AND DATE(date) = DATE(?)
  `, [request.employee_id, request.request_date]);

  if (attendanceRecords.length > 0) {
    // Update existing record
    await connection.query(`
      UPDATE attendance 
      SET status = 'Leave',
          remarks = CONCAT(IFNULL(remarks, ''), ' Leave approved via request #${requestId}'),
          updated_at = NOW()
      WHERE id = ?
    `, [attendanceRecords[0].id]);
    
    console.log(`Updated existing attendance record to On Leave for request #${requestId}`);
  } else {
    // Create new attendance record with On Leave status
    await connection.query(`
      INSERT INTO attendance 
      (employee_id, date, status, remarks, created_at, updated_at)
      VALUES (?, ?, 'Leave', 'Leave approved via request #${requestId}', NOW(), NOW())
    `, [request.employee_id, request.request_date]);
    
    console.log(`Created new On Leave attendance record for request #${requestId}`);
  }
}

  // COMPREHENSIVE NOTIFICATION FOR EMPLOYEE DECISION
async notifyEmployeeDecisionComprehensive(employee, request, status, review_notes, requestType = 'unmark_absent') {
  try {
    console.log(`🔔 Starting comprehensive decision notification for ${requestType} request ${request.id}`, {
      environment: this.isProduction ? 'production' : 'development/staging',
      smsEnabled: this.isProduction
    });
    
    const statusText = status === 'approved' ? 'approved' : 'rejected';
    const requestTypeText = this.getRequestTypeText(requestType);
    
    const message = status === 'approved' 
      ? `Your ${requestTypeText.toLowerCase()} request for ${request.request_date} has been approved. ${review_notes ? `Notes: ${review_notes}` : ''}`
      : `Your ${requestTypeText.toLowerCase()} request for ${request.request_date} has been rejected. ${review_notes ? `Reason: ${review_notes}` : ''}`;

    const notificationPromises = [];

    // Panel notification for employee
    if (employee.user_id) {
      notificationPromises.push(
        NotificationService.createNotification({
          userIds: [employee.user_id],
          title: `${requestTypeText} Request ${status === 'approved' ? 'Approved' : 'Rejected'}`,
          message: message,
          type: 'employee_request',
          module: 'attendance',
          moduleId: request.id
        }).catch(err => console.error(`Decision panel notification error:`, err))
      );
    }

    // Email notification to employee
    notificationPromises.push(
      this.sendDecisionEmailToEmployee(employee, request, status, review_notes, requestType)
        .catch(err => console.error(`Decision email error:`, err))
    );

    // SMS notification to employee - only in production
    if (employee.phone && this.isProduction) {
      notificationPromises.push(
        this.sendDecisionSMSToEmployee(employee, request, status, review_notes, requestType)
          .catch(err => console.error(`Decision SMS error:`, err))
      );
    } else if (employee.phone && !this.isProduction) {
      console.log(`ℹ️ Decision SMS skipped for employee ${employee.employeeName} - not in production environment`);
      notificationPromises.push(Promise.resolve({ type: 'sms', success: true, skipped: 'not_production' }));
    }

    // Execute all notification promises
    const results = await Promise.allSettled(notificationPromises);
    
    const successful = results.filter(result => result.status === 'fulfilled').length;
    const failed = results.filter(result => result.status === 'rejected').length;
    
    console.log(`✅ Decision notifications completed for ${requestType} request ${request.id}: ${successful} successful, ${failed} failed`);

  } catch (error) {
    console.error('❌ Error in comprehensive employee decision notification:', error);
  }
}

// SEND DECISION EMAIL TO EMPLOYEE
async sendDecisionEmailToEmployee(employee, request, status, review_notes, requestType = 'unmark_absent') {
  try {
    if (!employee.email) {
      console.log(`No email address for employee ${employee.employeeName}`);
      return;
    }

    const staffPortalLink = process.env.FRONTEND_URL || 'http://16.16.110.203';
    const employeeLink = `${staffPortalLink}/employee/requests`;
    const requestTypeText = this.getRequestTypeText(requestType);
    const statusText = status === 'approved' ? 'Approved' : 'Rejected';

    const statusColor = status === 'approved' ? '#d4edda' : '#f8d7da';
    const statusBorder = status === 'approved' ? '#c3e6cb' : '#f5c6cb';

    const emailHtml = `<!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; background: #f7f7fb; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 30px; }
        .status { background: ${statusColor}; border: 1px solid ${statusBorder}; border-radius: 6px; padding: 15px; margin: 20px 0; color: #155724; }
        .button { display: inline-block; background: #091D78; color: #fff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: bold; }
        .details { background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2 style="color: #091D78;">${requestTypeText} Request ${statusText}</h2>
        </div>
        
        <div class="status">
          <strong>Request ${statusText}:</strong> Your ${requestTypeText.toLowerCase()} request has been ${statusText.toLowerCase()}.
        </div>
        
        <div class="details">
          <h3>Request Details:</h3>
          <p><strong>Request Type:</strong> ${requestTypeText}</p>
          <p><strong>Request Date:</strong> ${request.request_date}</p>
          <p><strong>Request ID:</strong> #${request.id}</p>
          <p><strong>Status:</strong> ${statusText}</p>
          ${review_notes ? `<p><strong>Review Notes:</strong> ${review_notes}</p>` : ''}
          <p><strong>Reviewed On:</strong> ${new Date().toLocaleDateString()}</p>
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${employeeLink}" class="button">View My Requests</a>
        </div>
        
        <p style="color: #666; font-size: 14px;">
          If you have any questions, please contact HR department.
        </p>
      </div>
    </body>
    </html>`;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: `"Icebergs India - HR System" <${process.env.EMAIL_USER}>`,
      to: employee.email,
      subject: `${requestTypeText} Request ${statusText} - ${request.request_date}`,
      html: emailHtml
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ ${requestTypeText} decision email sent to employee ${employee.email}`);

  } catch (error) {
    console.error('❌ Error sending decision email to employee:', error);
    throw error;
  }
}

// SEND DECISION SMS TO EMPLOYEE
async sendDecisionSMSToEmployee(employee, request, status, review_notes, requestType = 'unmark_absent') {
  try {
    // Only send SMS in production environment
    if (!this.isProduction) {
      console.log(`ℹ️ Decision SMS skipped for employee ${employee.employeeName} - not in production environment`);
      return { skipped: true, reason: 'not_production' };
    }

    if (!employee.phone || !twilioClient) {
      console.log(`No phone number or Twilio not configured for employee ${employee.employeeName}`);
      return;
    }

    const cleanPhone = employee.phone.replace(/[^\d+]/g, '');
    const formattedPhone = `+91${cleanPhone}`;
    const requestTypeText = this.getRequestTypeText(requestType);
    const statusText = status === 'approved' ? 'approved' : 'rejected';

    const message = `Your ${requestTypeText.toLowerCase()} request for ${request.request_date} has been ${statusText}. ${review_notes ? `Notes: ${review_notes.substring(0, 50)}` : ''}`;

    const messageOptions = {
      body: message,
      to: formattedPhone
    };

    if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
      messageOptions.messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
    } else if (process.env.TWILIO_PHONE_NUMBER) {
      messageOptions.from = process.env.TWILIO_PHONE_NUMBER;
    } else {
      console.log('Twilio not properly configured for SMS');
      return;
    }

    await twilioClient.messages.create(messageOptions);
    console.log(`✅ ${requestTypeText} decision SMS sent to employee ${formattedPhone}`);

  } catch (error) {
    console.error('❌ Error sending decision SMS to employee:', error);
    throw error;
  }
}

  // TEST NOTIFICATION ENDPOINT
  async testNotification(req, res) {
    try {
      const { employeeId, type } = req.body;
      
      // Get employee details
      const [employees] = await db.query(`
        SELECT e.*, u.id as user_id 
        FROM employees e 
        LEFT JOIN users u ON e.id = u.employee_id 
        WHERE e.id = ?
      `, [employeeId]);

      if (employees.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Employee not found'
        });
      }

      const employee = employees[0];
      const testRequestId = 9999;
      const testDate = new Date().toISOString().split('T')[0];
      const testReason = 'Test notification reason';

      let result;

      if (type === 'submission') {
        // Test submission notifications
        result = await this.notifyHRAndAdminsComprehensive(employee, testDate, testReason, testRequestId);
        await this.notifyEmployeeRequestSubmitted(employee, testDate, testReason, testRequestId);
      } else if (type === 'decision') {
        // Test decision notifications
        const testRequest = {
          id: testRequestId,
          request_date: testDate,
          employee_id: employeeId
        };
        result = await this.notifyEmployeeDecisionComprehensive(employee, testRequest, 'approved', 'Test approval notes');
      } else {
        return res.status(400).json({
          success: false,
          message: 'Invalid type. Use "submission" or "decision"'
        });
      }

      res.json({
        success: true,
        message: `Test ${type} notifications triggered`,
        data: {
          employee: employee.employeeName,
          type: type,
          result: result,
          environment: this.isProduction ? 'production' : 'development/staging',
          smsEnabled: this.isProduction
        }
      });

    } catch (error) {
      console.error('Error testing notification:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to test notification',
        error: error.message
      });
    }
  }

  async serveRequestDocument(req, res) {
  try {
    const { filename } = req.params;
    
    // Construct the file path
    const fs = require('fs');
    const path = require('path');
    
    // Resolve the file path
    const filePath = path.join(__dirname, '..', 'uploads', 'requests', filename);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: 'Document not found'
      });
    }
    
    // Set appropriate headers based on file type
    const ext = path.extname(filename).toLowerCase();
    let contentType = 'application/octet-stream';
    
    if (ext === '.pdf') {
      contentType = 'application/pdf';
    } else if (ext === '.jpg' || ext === '.jpeg') {
      contentType = 'image/jpeg';
    } else if (ext === '.png') {
      contentType = 'image/png';
    } else if (ext === '.doc') {
      contentType = 'application/msword';
    } else if (ext === '.docx') {
      contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    
    // Set headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    
    // Send the file
    res.sendFile(filePath);
    
  } catch (error) {
    console.error('Error serving document:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to serve document',
      error: error.message
    });
  }
}
}

// Create instance and export
const employeeRequestController = new EmployeeRequestController();
module.exports = employeeRequestController;