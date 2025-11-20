const db = require('../config/db');
const pool = require('../config/db');
const NotificationService = require('../services/notificationService');
const twilio = require('twilio');
const nodemailer = require('nodemailer');

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

class AnnouncementController {
    constructor() {
        // Bind all methods to maintain 'this' context
        this.getAnnouncements = this.getAnnouncements.bind(this);
        this.createAnnouncement = this.createAnnouncement.bind(this);
        this.sendAnnouncementNotificationsComprehensive = this.sendAnnouncementNotificationsComprehensive.bind(this);
        this.sendAnnouncementEmailToUser = this.sendAnnouncementEmailToUser.bind(this);
        this.sendAnnouncementSMSToUser = this.sendAnnouncementSMSToUser.bind(this);
        this.sendBirthdayAnnouncement = this.sendBirthdayAnnouncement.bind(this);
        this.sendBirthdayWishToEmployee = this.sendBirthdayWishToEmployee.bind(this);
        this.sendBirthdayWishSMS = this.sendBirthdayWishSMS.bind(this);
        this.sendBirthdayEmailToUser = this.sendBirthdayEmailToUser.bind(this);
        this.sendBirthdaySMSToUser = this.sendBirthdaySMSToUser.bind(this);
        this.sendBirthdayNotifications = this.sendBirthdayNotifications.bind(this);
        this.truncateMessage = this.truncateMessage.bind(this);
        this.getPriorityInfo = this.getPriorityInfo.bind(this);
        this.deleteAnnouncement = this.deleteAnnouncement.bind(this);
        this.updateAnnouncement = this.updateAnnouncement.bind(this);
        this.getAnnouncementById = this.getAnnouncementById.bind(this);
        this.getActiveAnnouncements = this.getActiveAnnouncements.bind(this);
        this.testAnnouncementNotifications = this.testAnnouncementNotifications.bind(this);
        this.testConnection = this.testConnection.bind(this);
        this.getEmployeesForBirthday = this.getEmployeesForBirthday.bind(this);
    }

    // Get all announcements
    async getAnnouncements(req, res) {
        try {
            console.log('Fetching announcements...');
            
            const query = `
                SELECT a.*, 
                       u.name as created_by_name,
                       e.employeeName as employee_name,
                       e.position as employee_position
                FROM announcements a 
                LEFT JOIN users u ON a.created_by = u.id 
                LEFT JOIN employees e ON a.employee_id = e.id
                ORDER BY a.created_at DESC
            `;
            
            const [results] = await pool.query(query);
            
            console.log('Found announcements:', results.length);
            
            res.json({
                success: true,
                announcements: results
            });
        } catch (error) {
            console.log('Database error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch announcements',
                error: error.message
            });
        }
    }

    // Create new announcement with comprehensive notifications
    async createAnnouncement(req, res) {
        let connection;
        try {
            const { title, message, priority = 'medium', expiry_date, is_birthday_announcement = false, employee_id } = req.body;
            const createdBy = req.user?.id || 1; // Get user ID from authenticated user
            
            console.log('Creating announcement:', { 
                title, 
                message, 
                priority, 
                expiry_date, 
                createdBy, 
                is_birthday_announcement, 
                employee_id 
            });

            // Validation
            if (!title || !message) {
                return res.status(400).json({
                    success: false,
                    message: 'Title and message are required'
                });
            }

            // Additional validation for birthday announcements
            if (is_birthday_announcement && !employee_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Employee selection is required for birthday announcements'
                });
            }

            connection = await pool.getConnection();
            await connection.beginTransaction();

            const query = `
                INSERT INTO announcements (title, message, priority, expiry_date, created_by, employee_id)
                VALUES (?, ?, ?, ?, ?, ?)
            `;

            const params = [
                title.trim(),
                message.trim(),
                priority,
                expiry_date || null,
                createdBy,
                is_birthday_announcement ? employee_id : null
            ];

            const [result] = await connection.query(query, params);
            const announcementId = result.insertId;

            // Get creator details for notification
            const [creatorDetails] = await connection.query(`
                SELECT u.name, u.email, e.phone 
                FROM users u 
                LEFT JOIN employees e ON u.employee_id = e.id 
                WHERE u.id = ?
            `, [createdBy]);

            const creator = creatorDetails[0] || { name: 'System', email: null, phone: null };

            let excludeUserId = createdBy;
            let employeeName = creator.name;
            let birthdayEmployeeEmail = null;
            let birthdayEmployeePhone = null;

            // For birthday announcements, get employee details
            if (is_birthday_announcement && employee_id) {
                const [employeeDetails] = await connection.query(`
                    SELECT e.employeeName, e.email, e.phone, u.id as user_id 
                    FROM employees e 
                    LEFT JOIN users u ON u.employee_id = e.id 
                    WHERE e.id = ?
                `, [employee_id]);

                if (employeeDetails.length > 0) {
                    employeeName = employeeDetails[0].employeeName;
                    birthdayEmployeeEmail = employeeDetails[0].email;
                    birthdayEmployeePhone = employeeDetails[0].phone;
                    // Exclude the birthday person's user account if it exists
                    if (employeeDetails[0].user_id) {
                        excludeUserId = employeeDetails[0].user_id;
                    }
                }
            }

            // Send comprehensive notifications to all users except the excluded user
            const notificationResult = await this.sendAnnouncementNotificationsComprehensive(
                announcementId, 
                title, 
                message, 
                priority, 
                expiry_date,
                excludeUserId, // Exclude creator or birthday person
                creator.name,
                is_birthday_announcement,
                employeeName,
                birthdayEmployeeEmail,
                birthdayEmployeePhone
            );

            await connection.commit();

            console.log('Notification result:', notificationResult);

            res.json({
                success: true,
                message: is_birthday_announcement ? 
                    'Birthday announcement created successfully and notifications sent' : 
                    'Announcement created successfully and notifications sent',
                id: announcementId,
                notificationResult: notificationResult
            });
        } catch (error) {
            if (connection) await connection.rollback();
            console.log('Database error in createAnnouncement:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to create announcement',
                error: error.message
            });
        } finally {
            if (connection) connection.release();
        }
    }

    // Send birthday announcement
    async sendBirthdayAnnouncement(req, res) {
        let connection;
        try {
            const { employee_id, custom_message } = req.body;
            const createdBy = req.user?.id || 1;

            console.log('Sending birthday announcement for employee:', employee_id);

            if (!employee_id) {
                return res.status(400).json({
                    success: false,
                    message: 'Employee ID is required for birthday announcements'
                });
            }

            connection = await pool.getConnection();
            await connection.beginTransaction();

            // Get employee details
            const [employeeDetails] = await connection.query(`
                SELECT e.employeeName, e.position, e.email, e.phone, u.id as user_id 
                FROM employees e 
                LEFT JOIN users u ON u.employee_id = e.id 
                WHERE e.id = ?
            `, [employee_id]);

            if (employeeDetails.length === 0) {
                await connection.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Employee not found'
                });
            }

            const employee = employeeDetails[0];
            const employeeName = employee.employeeName;
            const position = employee.position || 'Team Member';
            const employeeEmail = employee.email;
            const employeePhone = employee.phone;

            // Create birthday announcement
            const title = `🎉 Happy Birthday ${employeeName}!`;
            const message = custom_message || `Wishing ${employeeName} (${position}) a very happy birthday! May your special day be filled with joy and happiness. 🎂🎈`;

            const query = `
                INSERT INTO announcements (title, message, priority, created_by, employee_id)
                VALUES (?, ?, 'high', ?, ?)
            `;

            const [result] = await connection.query(query, [
                title,
                message,
                createdBy,
                employee_id
            ]);

            const announcementId = result.insertId;

            // Get creator details
            const [creatorDetails] = await connection.query(`
                SELECT u.name, u.email, e.phone 
                FROM users u 
                LEFT JOIN employees e ON u.employee_id = e.id 
                WHERE u.id = ?
            `, [createdBy]);

            const creator = creatorDetails[0] || { name: 'System', email: null, phone: null };

            // Exclude the birthday person's user account if it exists
            const excludeUserId = employee.user_id || createdBy;

            // Send birthday notifications to all users including special notification for birthday person
            const notificationResult = await this.sendBirthdayNotifications(
                announcementId,
                title,
                message,
                excludeUserId,
                creator.name,
                employeeName,
                position,
                employeeEmail,
                employeePhone
            );

            await connection.commit();

            console.log('Birthday notification result:', notificationResult);

            res.json({
                success: true,
                message: 'Birthday announcement sent successfully',
                id: announcementId,
                employee: {
                    name: employeeName,
                    position: position
                },
                notificationResult: notificationResult
            });

        } catch (error) {
            if (connection) await connection.rollback();
            console.log('Error sending birthday announcement:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to send birthday announcement',
                error: error.message
            });
        } finally {
            if (connection) connection.release();
        }
    }

    // Send birthday notifications
    async sendBirthdayNotifications(announcementId, title, message, excludeUserId, creatorName, employeeName, position, employeeEmail, employeePhone) {
        try {
            console.log(`🎂 Starting birthday notifications for ${employeeName}`);
            
            // Get all active users except the birthday person
            const [users] = await pool.query(`
                SELECT 
                    u.id, 
                    u.name, 
                    u.email, 
                    u.employee_id,
                    e.phone,
                    e.employeeName as employee_name
                FROM users u 
                LEFT JOIN employees e ON u.employee_id = e.id 
                WHERE u.id != ? 
                AND (u.email IS NOT NULL OR e.phone IS NOT NULL)
            `, [excludeUserId]);

            if (users.length === 0) {
                console.log('No users found for birthday notification');
                return {
                    totalUsers: 0,
                    totalNotifications: 0,
                    successful: 0,
                    failed: 0
                };
            }

            console.log(`Found ${users.length} users to notify about birthday`);

            const notificationPromises = [];

            // Send special birthday wish to the birthday employee
            if (employeeEmail) {
                notificationPromises.push(
                    this.sendBirthdayWishToEmployee(employeeEmail, employeeName, position, creatorName, announcementId)
                        .then(() => ({ type: 'birthday_wish_email', success: true }))
                        .catch(err => {
                            console.error(`Birthday wish email error for ${employeeName}:`, err);
                            return { type: 'birthday_wish_email', success: false, error: err.message };
                        })
                );
            }

            if (employeePhone) {
                notificationPromises.push(
                    this.sendBirthdayWishSMS(employeePhone, employeeName, creatorName, announcementId)
                        .then(() => ({ type: 'birthday_wish_sms', success: true }))
                        .catch(err => {
                            console.error(`Birthday wish SMS error for ${employeeName}:`, err);
                            return { type: 'birthday_wish_sms', success: false, error: err.message };
                        })
                );
            }

            // Collect all emails for CC
            const ccEmails = users.map(user => user.email).filter(email => email);

            // Send notifications to other employees
            for (const user of users) {
                const userNotificationPromises = [];

                // Panel notification
                userNotificationPromises.push(
                    NotificationService.createNotification({
                        userIds: [user.id],
                        title: title,
                        message: this.truncateMessage(message, 100),
                        type: 'birthday',
                        module: 'announcements',
                        moduleId: announcementId
                    }).then(() => ({ type: 'panel', success: true }))
                    .catch(err => {
                        console.error(`Panel notification error for user ${user.id}:`, err);
                        return { type: 'panel', success: false, error: err.message };
                    })
                );

                // Email notification - send to individual with CC to all others
                if (user.email) {
                    userNotificationPromises.push(
                        this.sendBirthdayEmailToUser(user, title, message, employeeName, position, announcementId, ccEmails)
                            .then(() => ({ type: 'email', success: true }))
                            .catch(err => {
                                console.error(`Email error for user ${user.id}:`, err);
                                return { type: 'email', success: false, error: err.message };
                            })
                    );
                }

                // SMS notification
                if (user.phone) {
                    userNotificationPromises.push(
                        this.sendBirthdaySMSToUser(user, title, message, employeeName, announcementId)
                            .then(() => ({ type: 'sms', success: true }))
                            .catch(err => {
                                console.error(`SMS error for user ${user.id}:`, err);
                                return { type: 'sms', success: false, error: err.message };
                            })
                    );
                }

                // Execute all notifications for this user
                notificationPromises.push(
                    Promise.allSettled(userNotificationPromises).then(results => {
                        const successful = results.filter(result => 
                            result.status === 'fulfilled' && result.value && result.value.success === true
                        ).length;
                        const failed = results.filter(result => 
                            result.status === 'rejected' || (result.status === 'fulfilled' && result.value && result.value.success === false)
                        ).length;
                        console.log(`User ${user.id} (${user.name}) birthday notifications: ${successful} successful, ${failed} failed`);
                        return { 
                            userId: user.id, 
                            userName: user.name, 
                            successful, 
                            failed 
                        };
                    })
                );
            }

            // Wait for all user notifications to complete
            const allResults = await Promise.allSettled(notificationPromises);
            
            let totalSuccessful = 0;
            let totalFailed = 0;

            allResults.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    if (typeof result.value.successful === 'number') {
                        totalSuccessful += result.value.successful;
                    }
                    if (typeof result.value.failed === 'number') {
                        totalFailed += result.value.failed;
                    }
                } else {
                    totalFailed++;
                }
            });

            console.log(`✅ Birthday notifications completed for ${employeeName}: ${totalSuccessful} successful, ${totalFailed} failed`);

            return {
                totalUsers: users.length,
                totalNotifications: totalSuccessful + totalFailed,
                successful: totalSuccessful,
                failed: totalFailed,
                details: allResults
            };

        } catch (error) {
            console.error('❌ Error in birthday notification:', error);
            throw error;
        }
    }

    // Send special birthday wish email to the birthday employee
    async sendBirthdayWishToEmployee(employeeEmail, employeeName, position, creatorName, announcementId) {
        try {
            if (!employeeEmail) {
                console.log(`No email address for birthday employee ${employeeName}`);
                return;
            }

            const staffPortalLink = process.env.FRONTEND_URL || 'http://16.16.110.203';

            const emailHtml = `<!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; background: #f7f7fb; margin: 0; padding: 20px; }
                    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                    .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #f1f5f9; padding-bottom: 20px; }
                    .birthday-icon { font-size: 48px; margin-bottom: 20px; }
                    .wish-content { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border-radius: 8px; padding: 30px; margin: 20px 0; line-height: 1.6; text-align: center; }
                    .button { display: inline-block; background: #091D78; color: #fff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: bold; margin: 10px 0; }
                    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 14px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <div class="birthday-icon">🎉</div>
                        <h2 style="color: #091D78; margin: 0;">Happy Birthday ${employeeName}!</h2>
                    </div>
                    
                    <div class="wish-content">
                        <h3 style="margin: 0 0 20px 0; font-size: 28px;">🎂 Happy Birthday! 🎂</h3>
                        <p style="font-size: 18px; margin: 0; opacity: 0.9;">
                            Dear ${employeeName},<br><br>
                            On behalf of the entire Icebergs India family, we wish you a very happy birthday!<br><br>
                            May your special day be filled with joy, laughter, and wonderful moments.<br>
                            Thank you for your valuable contributions to our team.<br><br>
                            Enjoy your day to the fullest! 🎈
                        </p>
                    </div>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <p style="color: #6b7280; margin-bottom: 20px;">
                            Wishing you a fantastic year ahead!
                        </p>
                        <p style="color: #374151; font-style: italic;">
                            With warm regards,<br>
                            ${creatorName} and the entire Icebergs India Team
                        </p>
                    </div>
                    
                    <div class="footer">
                        <p style="margin: 0;">
                            This is a special birthday wish from Icebergs India HR System.<br>
                            Please do not reply to this email.
                        </p>
                    </div>
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
                from: `"Icebergs India - Birthday Wishes" <${process.env.EMAIL_USER}>`,
                to: employeeEmail,
                subject: `🎉 Happy Birthday ${employeeName}! - Special Wishes from Icebergs India`,
                html: emailHtml
            };

            await transporter.sendMail(mailOptions);
            console.log(`✅ Special birthday wish email sent to ${employeeName} at ${employeeEmail}`);

        } catch (error) {
            console.error('❌ Error sending birthday wish email to employee:', error);
            throw error;
        }
    }

    // Send special birthday wish SMS to the birthday employee
    async sendBirthdayWishSMS(employeePhone, employeeName, creatorName, announcementId) {
        try {
            if (!employeePhone || !process.env.TWILIO_ACCOUNT_SID) {
                console.log(`No phone number or Twilio not configured for birthday employee ${employeeName}`);
                return;
            }

            const cleanPhone = employeePhone.replace(/[^\d+]/g, '');
            
            // Ensure phone number has country code
            let formattedPhone = cleanPhone;
            if (!cleanPhone.startsWith('+')) {
                formattedPhone = `+91${cleanPhone}`;
            }

            const smsMessage = `🎉 Happy Birthday ${employeeName}! 🎂

On behalf of Icebergs India, we wish you a wonderful birthday filled with joy and happiness!

May your special day be as amazing as you are. Enjoy your day to the fullest!

Warm regards,
${creatorName} & Icebergs India Team

- Icebergs India HR System`;

            const messageOptions = {
                body: smsMessage,
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
            console.log(`✅ Special birthday wish SMS sent to ${employeeName} at ${formattedPhone}`);

        } catch (error) {
            console.error('❌ Error sending birthday wish SMS to employee:', error);
            throw error;
        }
    }

    // Send birthday email to other users (not the birthday person)
    async sendBirthdayEmailToUser(user, title, message, employeeName, position, announcementId, ccEmails = []) {
        try {
            if (!user.email) {
                console.log(`No email address for user ${user.name}`);
                return;
            }

            const staffPortalLink = process.env.FRONTEND_URL || 'http://16.16.110.203';
            const announcementLink = `${staffPortalLink}/announcements`;

            const emailHtml = `<!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; background: #f7f7fb; margin: 0; padding: 20px; }
                    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                    .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #f1f5f9; padding-bottom: 20px; }
                    .birthday-icon { font-size: 48px; margin-bottom: 20px; }
                    .announcement-content { background: #fff8e1; border-radius: 8px; padding: 20px; margin: 20px 0; line-height: 1.6; border-left: 4px solid #ffd54f; }
                    .button { display: inline-block; background: #091D78; color: #fff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: bold; margin: 10px 0; }
                    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 14px; }
                    .employee-card { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <div class="birthday-icon">🎉</div>
                        <h2 style="color: #091D78; margin: 0;">Birthday Celebration!</h2>
                    </div>
                    
                    <div class="employee-card">
                        <h3 style="margin: 0 0 10px 0; font-size: 24px;">${employeeName}</h3>
                        <p style="margin: 0; opacity: 0.9;">${position}</p>
                    </div>
                    
                    <div class="announcement-content">
                        <h4 style="margin-top: 0; color: #374151;">Celebration Message:</h4>
                        <div style="white-space: pre-wrap; font-size: 16px; color: #7c2d12;">${message}</div>
                    </div>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <p style="color: #6b7280; margin-bottom: 20px;">
                            Let's wish ${employeeName} a wonderful birthday! 🎂
                        </p>
                        <a href="${announcementLink}" class="button">View All Announcements</a>
                    </div>
                    
                    <div class="footer">
                        <p style="margin: 0;">
                            This is an automated birthday notification from Icebergs India HR System.<br>
                            Please do not reply to this email.
                        </p>
                    </div>
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
                from: `"Icebergs India - Birthday Wishes" <${process.env.EMAIL_USER}>`,
                to: user.email,
                cc: ccEmails.filter(email => email !== user.email), // CC all other employees except current recipient
                subject: title,
                html: emailHtml
            };

            await transporter.sendMail(mailOptions);
            console.log(`✅ Birthday announcement email sent to user ${user.email}`);

        } catch (error) {
            console.error('❌ Error sending birthday email to user:', error);
            throw error;
        }
    }

    // Send birthday SMS to other users (not the birthday person)
    async sendBirthdaySMSToUser(user, title, message, employeeName, announcementId) {
        try {
            if (!user.phone || !process.env.TWILIO_ACCOUNT_SID) {
                console.log(`No phone number or Twilio not configured for user ${user.name}`);
                return;
            }

            const cleanPhone = user.phone.replace(/[^\d+]/g, '');
            
            // Ensure phone number has country code
            let formattedPhone = cleanPhone;
            if (!cleanPhone.startsWith('+')) {
                formattedPhone = `+91${cleanPhone}`;
            }

            const smsMessage = `🎉 Birthday Celebration!

Today is ${employeeName}'s birthday!

${message}

Let's wish ${employeeName} a wonderful birthday! 🎂

- Icebergs India HR System`;

            const messageOptions = {
                body: smsMessage,
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
            console.log(`✅ Birthday SMS sent to user ${formattedPhone} (${user.name})`);

        } catch (error) {
            console.error('❌ Error sending birthday SMS to user:', error);
            throw error;
        }
    }

    // Get employees for birthday selection
    async getEmployeesForBirthday(req, res) {
        try {
            console.log('Fetching employees for birthday selection...');
            
            const query = `
                SELECT 
                    e.id,
                    e.employeeName,
                    e.position,
                    e.department,
                    e.email,
                    e.phone,
                    DATE_FORMAT(e.birthday, '%d-%m-%Y') as birthday
                FROM employees e
                ORDER BY e.employeeName
            `;
            
            const [results] = await pool.query(query);
            
            console.log('Found employees:', results.length);
            
            res.json({
                success: true,
                employees: results
            });
        } catch (error) {
            console.log('Database error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch employees',
                error: error.message
            });
        }
    }

    // Updated comprehensive announcement notifications to handle birthday announcements
    async sendAnnouncementNotificationsComprehensive(announcementId, title, message, priority, expiry_date, excludeUserId, creatorName, isBirthdayAnnouncement = false, employeeName = null, birthdayEmployeeEmail = null, birthdayEmployeePhone = null) {
        try {
            console.log(`🔔 Starting comprehensive announcement notifications for announcement ${announcementId}`);
            
            // Get all active users except the excluded user
            const [users] = await pool.query(`
                SELECT 
                    u.id, 
                    u.name, 
                    u.email, 
                    u.employee_id,
                    e.phone,
                    e.employeeName as employee_name
                FROM users u 
                LEFT JOIN employees e ON u.employee_id = e.id 
                WHERE u.id != ? 
                AND (u.email IS NOT NULL OR e.phone IS NOT NULL)
            `, [excludeUserId]);

            if (users.length === 0) {
                console.log('No active users found for announcement notification');
                return {
                    totalUsers: 0,
                    totalNotifications: 0,
                    successful: 0,
                    failed: 0
                };
            }

            console.log(`Found ${users.length} users to notify about announcement`);

            const notificationPromises = [];

            // For birthday announcements, send special wishes to the birthday employee
            if (isBirthdayAnnouncement && birthdayEmployeeEmail) {
                notificationPromises.push(
                    this.sendBirthdayWishToEmployee(birthdayEmployeeEmail, employeeName, '', creatorName, announcementId)
                        .then(() => ({ type: 'birthday_wish_email', success: true }))
                        .catch(err => {
                            console.error(`Birthday wish email error for ${employeeName}:`, err);
                            return { type: 'birthday_wish_email', success: false, error: err.message };
                        })
                );
            }

            if (isBirthdayAnnouncement && birthdayEmployeePhone) {
                notificationPromises.push(
                    this.sendBirthdayWishSMS(birthdayEmployeePhone, employeeName, creatorName, announcementId)
                        .then(() => ({ type: 'birthday_wish_sms', success: true }))
                        .catch(err => {
                            console.error(`Birthday wish SMS error for ${employeeName}:`, err);
                            return { type: 'birthday_wish_sms', success: false, error: err.message };
                        })
                );
            }

            // Collect all emails for CC (for birthday announcements)
            const ccEmails = isBirthdayAnnouncement ? users.map(user => user.email).filter(email => email) : [];

            // Send notifications to each user
            for (const user of users) {
                const userNotificationPromises = [];

                // Panel notification
                userNotificationPromises.push(
                    NotificationService.createNotification({
                        userIds: [user.id],
                        title: title,
                        message: this.truncateMessage(message, 100),
                        type: isBirthdayAnnouncement ? 'birthday' : 'announcement',
                        module: 'announcements',
                        moduleId: announcementId
                    }).then(() => ({ type: 'panel', success: true }))
                    .catch(err => {
                        console.error(`Panel notification error for user ${user.id}:`, err);
                        return { type: 'panel', success: false, error: err.message };
                    })
                );

                // Email notification
                if (user.email) {
                    if (isBirthdayAnnouncement) {
                        userNotificationPromises.push(
                            this.sendBirthdayEmailToUser(user, title, message, employeeName, '', announcementId, ccEmails)
                                .then(() => ({ type: 'email', success: true }))
                                .catch(err => {
                                    console.error(`Birthday email error for user ${user.id}:`, err);
                                    return { type: 'email', success: false, error: err.message };
                                })
                        );
                    } else {
                        userNotificationPromises.push(
                            this.sendAnnouncementEmailToUser(user, title, message, priority, expiry_date, creatorName, announcementId)
                                .then(() => ({ type: 'email', success: true }))
                                .catch(err => {
                                    console.error(`Email error for user ${user.id}:`, err);
                                    return { type: 'email', success: false, error: err.message };
                                })
                        );
                    }
                }

                // SMS notification
                if (user.phone) {
                    if (isBirthdayAnnouncement) {
                        userNotificationPromises.push(
                            this.sendBirthdaySMSToUser(user, title, message, employeeName, announcementId)
                                .then(() => ({ type: 'sms', success: true }))
                                .catch(err => {
                                    console.error(`Birthday SMS error for user ${user.id}:`, err);
                                    return { type: 'sms', success: false, error: err.message };
                                })
                        );
                    } else {
                        userNotificationPromises.push(
                            this.sendAnnouncementSMSToUser(user, title, message, priority, announcementId)
                                .then(() => ({ type: 'sms', success: true }))
                                .catch(err => {
                                    console.error(`SMS error for user ${user.id}:`, err);
                                    return { type: 'sms', success: false, error: err.message };
                                })
                        );
                    }
                }

                // Execute all notifications for this user
                notificationPromises.push(
                    Promise.allSettled(userNotificationPromises).then(results => {
                        let successful = 0;
                        let failed = 0;

                        results.forEach(result => {
                            if (result.status === 'fulfilled' && result.value && result.value.success === true) {
                                successful++;
                            } else {
                                failed++;
                            }
                        });

                        console.log(`User ${user.id} (${user.name}) notifications: ${successful} successful, ${failed} failed`);
                        return { 
                            userId: user.id, 
                            userName: user.name, 
                            successful, 
                            failed 
                        };
                    })
                );
            }

            // Wait for all user notifications to complete
            const allResults = await Promise.allSettled(notificationPromises);
            
            let totalSuccessful = 0;
            let totalFailed = 0;

            allResults.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    totalSuccessful += result.value.successful || 0;
                    totalFailed += result.value.failed || 0;
                } else {
                    totalFailed++;
                }
            });

            console.log(`✅ Announcement notifications completed for announcement ${announcementId}: ${totalSuccessful} successful, ${totalFailed} failed`);

            return {
                totalUsers: users.length,
                totalNotifications: totalSuccessful + totalFailed,
                successful: totalSuccessful,
                failed: totalFailed,
                details: allResults
            };

        } catch (error) {
            console.error('❌ Error in comprehensive announcement notification:', error);
            throw error;
        }
    }

    // Send announcement email to user (for regular announcements)
    async sendAnnouncementEmailToUser(user, title, message, priority, expiry_date, creatorName, announcementId) {
        try {
            if (!user.email) {
                console.log(`No email address for user ${user.name}`);
                return;
            }

            const staffPortalLink = process.env.FRONTEND_URL || 'http://16.16.110.203';
            const announcementLink = `${staffPortalLink}/announcements`;
            
            const priorityInfo = this.getPriorityInfo(priority);

            const emailHtml = `<!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; background: #f7f7fb; margin: 0; padding: 20px; }
                    .container { max-width: 600px; margin: 0 auto; background: #fff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                    .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #f1f5f9; padding-bottom: 20px; }
                    .priority-badge { display: inline-block; padding: 6px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; margin-left: 10px; }
                    .announcement-content { background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 20px 0; line-height: 1.6; }
                    .button { display: inline-block; background: #091D78; color: #fff; padding: 12px 30px; border-radius: 6px; text-decoration: none; font-weight: bold; margin: 10px 0; }
                    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 14px; }
                    .details-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0; }
                    .detail-item { background: #f8f9fa; padding: 10px 15px; border-radius: 6px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h2 style="color: #091D78; margin: 0;">New Announcement</h2>
                        <h3 style="color: #374151; margin: 10px 0;">
                            ${title}
                            <span class="priority-badge" style="background-color: ${priorityInfo.color}20; color: ${priorityInfo.color}; border: 1px solid ${priorityInfo.color}40;">
                                ${priorityInfo.text} Priority
                            </span>
                        </h3>
                    </div>
                    
                    <div class="details-grid">
                        <div class="detail-item">
                            <strong>From:</strong> ${creatorName}
                        </div>
                        <div class="detail-item">
                            <strong>Announcement ID:</strong> #${announcementId}
                        </div>
                        ${expiry_date ? `
                        <div class="detail-item">
                            <strong>Expires:</strong> ${new Date(expiry_date).toLocaleDateString('en-IN')}
                        </div>
                        ` : ''}
                        <div class="detail-item">
                            <strong>Date:</strong> ${new Date().toLocaleDateString('en-IN')}
                        </div>
                    </div>
                    
                    <div class="announcement-content">
                        <h4 style="margin-top: 0; color: #374151;">Message:</h4>
                        <div style="white-space: pre-wrap;">${message}</div>
                    </div>
                    
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${announcementLink}" class="button">View All Announcements</a>
                    </div>
                    
                    <div class="footer">
                        <p style="margin: 0;">
                            This is an automated notification from Icebergs India HR System.<br>
                            Please do not reply to this email.
                        </p>
                    </div>
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
                from: `"Icebergs India - Announcements" <${process.env.EMAIL_USER}>`,
                to: user.email,
                subject: `New Announcement: ${title}`,
                html: emailHtml
            };

            await transporter.sendMail(mailOptions);
            console.log(`✅ Announcement email sent to user ${user.email}`);

        } catch (error) {
            console.error('❌ Error sending announcement email to user:', error);
            throw error;
        }
    }

    // Send announcement SMS to user (for regular announcements)
    async sendAnnouncementSMSToUser(user, title, message, priority, announcementId) {
        try {
            if (!user.phone || !process.env.TWILIO_ACCOUNT_SID) {
                console.log(`No phone number or Twilio not configured for user ${user.name}`);
                return;
            }

            const cleanPhone = user.phone.replace(/[^\d+]/g, '');
            
            // Ensure phone number has country code
            let formattedPhone = cleanPhone;
            if (!cleanPhone.startsWith('+')) {
                formattedPhone = `+91${cleanPhone}`;
            }

            const priorityTexts = {
                low: '📢',
                medium: '📢📢',
                high: '📢📢📢',
                urgent: '🚨 URGENT'
            };

            const priorityEmoji = priorityTexts[priority] || '📢';
            const truncatedMessage = this.truncateMessage(message, 80);

            const smsMessage = `${priorityEmoji} New Announcement: ${title}

${truncatedMessage}

Announcement ID: ${announcementId}

Please check the staff portal for details.`;

            const messageOptions = {
                body: smsMessage,
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
            console.log(`✅ Announcement SMS sent to user ${formattedPhone} (${user.name})`);

        } catch (error) {
            console.error('❌ Error sending announcement SMS to user:', error);
            throw error;
        }
    }

    // Helper method to truncate message for notifications
    truncateMessage(message, maxLength) {
        if (message.length <= maxLength) return message;
        return message.substring(0, maxLength) + '...';
    }

    // Get priority color and text
    getPriorityInfo(priority) {
        const colors = {
            low: '#6B7280',
            medium: '#3B82F6',
            high: '#F59E0B',
            urgent: '#EF4444'
        };

        const texts = {
            low: 'Low',
            medium: 'Medium',
            high: 'High',
            urgent: 'Urgent'
        };

        return {
            color: colors[priority] || '#3B82F6',
            text: texts[priority] || 'Medium'
        };
    }

    // Delete announcement
    async deleteAnnouncement(req, res) {
        try {
            const { id } = req.params;
            console.log('Deleting announcement:', id);

            const query = 'DELETE FROM announcements WHERE id = ?';
            
            const [result] = await pool.query(query, [id]);

            if (result.affectedRows === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Announcement not found'
                });
            }

            res.json({
                success: true,
                message: 'Announcement deleted successfully'
            });
        } catch (error) {
            console.log('Database error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to delete announcement',
                error: error.message
            });
        }
    }

    // Update announcement
    async updateAnnouncement(req, res) {
        try {
            const { id } = req.params;
            const { title, message, priority, expiry_date, is_active } = req.body;

            console.log('Updating announcement:', id, { title, message, priority, expiry_date, is_active });

            // Check if announcement exists
            const [existing] = await pool.query('SELECT * FROM announcements WHERE id = ?', [id]);
            
            if (existing.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Announcement not found'
                });
            }

            const updateFields = [];
            const updateParams = [];

            if (title !== undefined) {
                updateFields.push('title = ?');
                updateParams.push(title.trim());
            }

            if (message !== undefined) {
                updateFields.push('message = ?');
                updateParams.push(message.trim());
            }

            if (priority !== undefined) {
                updateFields.push('priority = ?');
                updateParams.push(priority);
            }

            if (expiry_date !== undefined) {
                updateFields.push('expiry_date = ?');
                updateParams.push(expiry_date);
            }

            if (is_active !== undefined) {
                updateFields.push('is_active = ?');
                updateParams.push(is_active);
            }

            // Add updated_at timestamp
            updateFields.push('updated_at = CURRENT_TIMESTAMP');
            
            // Add ID as last parameter
            updateParams.push(id);

            if (updateFields.length === 1) { // Only updated_at was added
                return res.status(400).json({
                    success: false,
                    message: 'No fields to update'
                });
            }

            const query = `UPDATE announcements SET ${updateFields.join(', ')} WHERE id = ?`;
            
            const [result] = await pool.query(query, updateParams);

            res.json({
                success: true,
                message: 'Announcement updated successfully',
                affectedRows: result.affectedRows
            });
        } catch (error) {
            console.log('Database error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to update announcement',
                error: error.message
            });
        }
    }

    // Get single announcement by ID
    async getAnnouncementById(req, res) {
        try {
            const { id } = req.params;
            console.log('Fetching announcement:', id);

            const query = `
                SELECT a.*, u.name as created_by_name 
                FROM announcements a 
                LEFT JOIN users u ON a.created_by = u.id 
                WHERE a.id = ?
            `;
            
            const [results] = await pool.query(query, [id]);

            if (results.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Announcement not found'
                });
            }

            res.json({
                success: true,
                announcement: results[0]
            });
        } catch (error) {
            console.log('Database error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch announcement',
                error: error.message
            });
        }
    }

    // Get active announcements only
    async getActiveAnnouncements(req, res) {
        try {
            console.log('Fetching active announcements...');
            
            const query = `
                SELECT a.*, u.name as created_by_name 
                FROM announcements a 
                LEFT JOIN users u ON a.created_by = u.id 
               
                ORDER BY 
                    CASE a.priority 
                        WHEN 'urgent' THEN 1 
                        WHEN 'high' THEN 2 
                        WHEN 'medium' THEN 3 
                        WHEN 'low' THEN 4 
                    END,
                    a.created_at DESC
            `;
            
            const [results] = await pool.query(query);
            
            console.log('Found active announcements:', results.length);
            
            res.json({
                success: true,
                announcements: results
            });
        } catch (error) {
            console.log('Database error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch active announcements',
                error: error.message
            });
        }
    }

    // Test announcement notifications
    async testAnnouncementNotifications(req, res) {
        try {
            const { userId } = req.body;
            
            // Get user details with employee phone
            const [users] = await pool.query(`
                SELECT 
                    u.id, 
                    u.name, 
                    u.email, 
                    u.employee_id,
                    e.phone,
                    e.employeeName as employee_name
                FROM users u 
                LEFT JOIN employees e ON u.employee_id = e.id 
                WHERE u.id = ?
            `, [userId]);

            if (users.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }

            const user = users[0];
            const testAnnouncementId = 9999;
            const testTitle = 'Test Announcement';
            const testMessage = 'This is a test announcement to verify notification systems. Please ignore this message.';
            const testPriority = 'high';
            const testExpiryDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // 7 days from now

            console.log(`Testing notifications for user: ${user.name}`, {
                email: user.email,
                phone: user.phone,
                employeeName: user.employee_name
            });

            // Test all notification types
            const results = await Promise.allSettled([
                // Panel notification
                NotificationService.createNotification({
                    userIds: [user.id],
                    title: `Test: ${testTitle}`,
                    message: testMessage.substring(0, 100),
                    type: 'announcement',
                    module: 'announcements',
                    moduleId: testAnnouncementId
                }).then(() => ({ type: 'panel', success: true }))
                .catch(err => ({ type: 'panel', success: false, error: err.message })),
                
                // Email notification
                user.email ? this.sendAnnouncementEmailToUser(user, testTitle, testMessage, testPriority, testExpiryDate, 'Test System', testAnnouncementId)
                    .then(() => ({ type: 'email', success: true }))
                    .catch(err => ({ type: 'email', success: false, error: err.message })) 
                    : Promise.resolve({ type: 'email', success: true, skipped: 'No email' }),
                
                // SMS notification
                user.phone ? this.sendAnnouncementSMSToUser(user, testTitle, testMessage, testPriority, testAnnouncementId)
                    .then(() => ({ type: 'sms', success: true }))
                    .catch(err => ({ type: 'sms', success: false, error: err.message }))
                    : Promise.resolve({ type: 'sms', success: true, skipped: 'No phone' })
            ]);

            const successful = results.filter(result => 
                result.status === 'fulfilled' && result.value && result.value.success === true
            ).length;
            const failed = results.filter(result => 
                result.status === 'rejected' || (result.status === 'fulfilled' && result.value && result.value.success === false)
            ).length;

            res.json({
                success: true,
                message: `Test announcement notifications completed`,
                data: {
                    user: {
                        name: user.name,
                        email: user.email,
                        phone: user.phone,
                        employeeName: user.employee_name
                    },
                    results: {
                        successful,
                        failed,
                        details: results.map((result, index) => ({
                            type: ['Panel', 'Email', 'SMS'][index],
                            status: result.status,
                            value: result.status === 'fulfilled' ? result.value : result.reason
                        }))
                    }
                }
            });

        } catch (error) {
            console.error('Error testing announcement notifications:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to test announcement notifications',
                error: error.message
            });
        }
    }

    // Test connection
    async testConnection(req, res) {
        try {
            const [results] = await pool.query('SELECT 1 as test');
            
            res.json({
                success: true,
                message: 'Database connected successfully',
                test: results[0].test
            });
        } catch (error) {
            console.log('Database connection failed:', error);
            res.status(500).json({
                success: false,
                message: 'Database connection failed',
                error: error.message
            });
        }
    }
}

// Export class directly instead of instance
module.exports = new AnnouncementController();