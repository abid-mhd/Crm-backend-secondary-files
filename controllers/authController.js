const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const nodemailer = require('nodemailer');
const crypto = require('crypto');

exports.register = async (req, res) => {
  try {
    const { name, email, password, role = "staff", meta, photo } = req.body;

    // Validate required fields
    if (!name || !email || !password) {
      return res.status(400).json({ 
        success: false,
        message: "Name, email, and password are required" 
      });
    }

    const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
    if (rows.length > 0) {
      return res.status(400).json({ 
        success: false,
        message: "Email already exists" 
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const [result] = await pool.query(
      "INSERT INTO users (name, email, password, role, meta, photo) VALUES (?, ?, ?, ?, ?, ?)",
      [name, email, hashedPassword, role, JSON.stringify(meta || {}), photo || null]
    );

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      user: {
        id: result.insertId,
        name,
        email,
        role,
        meta: meta || {},
        photo: photo || null
      }
    });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ 
      success: false,
      message: "Error registering user", 
      error: err.message 
    });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate required fields
    if (!email || !password) {
      return res.status(400).json({ 
        success: false,
        message: "Email and password are required" 
      });
    }

    const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
    if (rows.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: "Invalid email or password" 
      });
    }

    const user = rows[0];

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ 
        success: false,
        message: "Invalid email or password" 
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      success: true,
      message: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user?.role,
        meta: user?.meta ? user.meta : {},
        photo: user?.photo
      }
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ 
      success: false,
      message: "Error logging in", 
      error: err.message 
    });
  }
};

exports.createPassword = async (req, res) => {
  try {
    const { email, token, password } = req.body;

    if (!email || !token || !password) {
      return res.status(400).json({ 
        success: false,
        message: "Email, token, and password are required" 
      });
    }

    // Validate invitation first
    const [employees] = await pool.query(
      'SELECT * FROM employees WHERE email = ? AND temp_password = ? AND invitation_sent IS NOT NULL',
      [email, token]
    );

    if (employees.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid or expired invitation' 
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    await pool.query(
      'UPDATE employees SET password = ?, temp_password = NULL, invitation_completed = NOW() WHERE email = ?',
      [hashedPassword, email]
    );

    res.json({ 
      success: true, 
      message: 'Password created successfully' 
    });

  } catch (error) {
    console.error('Error creating password:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
};

exports.updatePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    // Debug log to check req.user
    console.log('User from token:', req.user);
    
    if (!req.user || !req.user.id) {
      return res.status(401).json({ 
        success: false,
        message: "Authentication required. Please log in again." 
      });
    }

    const userId = req.user.id;

    // Validate required fields
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ 
        success: false,
        message: "Current password and new password are required" 
      });
    }

    // Validate password strength
    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters long"
      });
    }

    // Get user from database
    const [users] = await pool.query("SELECT * FROM users WHERE id = ?", [userId]);
    if (users.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: "User not found" 
      });
    }

    const user = users[0];

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ 
        success: false,
        message: "Current password is incorrect" 
      });
    }

    // Check if new password is different from current password
    const isSamePassword = await bcrypt.compare(newPassword, user.password);
    if (isSamePassword) {
      return res.status(400).json({
        success: false,
        message: "New password must be different from current password"
      });
    }

    // Hash new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);

    // Update password in database
    await pool.query(
      "UPDATE users SET password = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?",
      [hashedNewPassword, userId]
    );

    res.json({
      success: true,
      message: "Password updated successfully"
    });

  } catch (err) {
    console.error("Update password error:", err);
    res.status(500).json({ 
      success: false,
      message: "Error updating password", 
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  }
};

// Forgot password - send reset token with email
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    // Check if user exists
    const [users] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
    
    // Don't reveal whether email exists or not for security
    if (users.length === 0) {
      return res.json({
        success: true,
        message: "If the email exists, a password reset link has been sent"
      });
    }

    const user = users[0];
    
    // Generate secure reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store reset token in database
    await pool.query(
      "UPDATE users SET reset_token = ?, reset_token_expiry = ? WHERE id = ?",
      [resetToken, resetTokenExpiry, user.id]
    );

    // Create reset link with token and email encoded
    const resetData = {
      email: user.email,
      token: resetToken,
      timestamp: Date.now()
    };
    
    const encodedResetData = Buffer.from(JSON.stringify(resetData)).toString('base64');
    const resetLink = `${process.env.FRONTEND_URL || 'http://16.16.110.203'}/reset-password?token=${encodedResetData}`;

    // Send reset email
    await sendResetEmail(user.email, user.name, resetLink);

    console.log(`✅ Password reset email sent to ${user.email}`);

    res.json({
      success: true,
      message: "If the email exists, a password reset link has been sent"
    });

  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({
      success: false,
      message: "Error processing forgot password request",
      error: err.message
    });
  }
};

// Send password reset email
const sendResetEmail = async (email, name, resetLink) => {
  try {
    // Email HTML with professional styling
    const emailHtml = `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>Password Reset Request</title>
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
          Password Reset Request
        </h2>

        <!-- Greeting -->
        <p style="font-size: 15px; color: #555; line-height: 1.6; margin-bottom: 20px;">
          Hi <strong>${name}</strong>,
        </p>
        
        <p style="font-size: 15px; color: #555; line-height: 1.6; margin-bottom: 25px;">
          We received a request to reset your password for your Staff Portal account. 
          If you didn't make this request, you can safely ignore this email.
        </p>

        <!-- Reset Button -->
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetLink}" 
             style="display: inline-block; background: #091D78; color: #fff; padding: 14px 40px; 
                    border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 16px;
                    transition: background-color 0.3s;">
            Reset Your Password
          </a>
        </div>

        <!-- Link Backup -->
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; margin-bottom: 25px;">
          <p style="font-size: 14px; color: #555; margin: 0 0 10px 0;">
            <strong>Or copy and paste this link in your browser:</strong>
          </p>
          <p style="font-size: 12px; color: #091D78; word-break: break-all; margin: 0;">
            ${resetLink}
          </p>
        </div>

        <!-- Security Information -->
        <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 15px; margin-bottom: 20px;">
          <p style="margin: 0; color: #856404; font-size: 14px; line-height: 1.5;">
            <strong>🔒 Security Information:</strong>
          </p>
          <ul style="margin: 10px 0 0 0; padding-left: 20px; color: #856404; font-size: 13px;">
            <li>This link will expire in 1 hour</li>
            <li>Do not share this link with anyone</li>
            <li>Our team will never ask for your password</li>
          </ul>
        </div>

        <!-- Expiration Notice -->
        <div style="background: #d1ecf1; border: 1px solid #bee5eb; border-radius: 6px; padding: 12px; margin-bottom: 20px;">
          <p style="margin: 0; color: #0c5460; font-size: 13px; text-align: center;">
            <strong>⏰ Link Expires:</strong> This password reset link is valid for 1 hour only.
          </p>
        </div>

        <!-- Footer -->
        <div style="border-top: 2px solid #e2e8f0; padding-top: 20px; margin-top: 30px;">
          <p style="font-size: 14px; color: #555; line-height: 1.6; margin: 0;">
            If you didn't request a password reset, please ignore this email or contact support if you have concerns.
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
Password Reset Request

Hi ${name},

We received a request to reset your password for your Staff Portal account. 
If you didn't make this request, you can safely ignore this email.

Reset Your Password: ${resetLink}

🔒 Security Information:
- This link will expire in 1 hour
- Do not share this link with anyone
- Our team will never ask for your password

⏰ Link Expires: This password reset link is valid for 1 hour only.

If you didn't request a password reset, please ignore this email or contact support if you have concerns.

Best regards,
The Icebergs Team

www.icebergsindia.com
${process.env.EMAIL_USER || 'garan6104@gmail.com'}
    `;

    // Create Gmail transporter
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    // Email options
    const mailOptions = {
      from: `"Icebergs India - Password Reset" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `Password Reset Request - Staff Portal`,
      html: emailHtml,
      text: textVersion
    };

    // Send email
    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Password reset email sent. Message ID:', info.messageId);
    
    return true;

  } catch (error) {
    console.error('❌ Error sending password reset email:', error);
    throw error;
  }
};

// Optional: Reset password with token
exports.resetPassword = async (req, res) => {
  try {
    const { token, email, newPassword } = req.body;

    if (!token || !email || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Token, email, and new password are required"
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters long"
      });
    }

    // Find user with valid reset token
    const [users] = await pool.query(
      "SELECT * FROM users WHERE email = ? AND reset_token = ? AND reset_token_expiry > NOW()",
      [email, token]
    );

    if (users.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired reset token"
      });
    }

    const user = users[0];

    // Hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Update password and clear reset token
    await pool.query(
      "UPDATE users SET password = ?, reset_token = NULL, reset_token_expiry = NULL, updatedAt = CURRENT_TIMESTAMP WHERE id = ?",
      [hashedPassword, user.id]
    );

    res.json({
      success: true,
      message: "Password reset successfully"
    });

  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({
      success: false,
      message: "Error resetting password",
      error: err.message
    });
  }
};

exports.getCurrentUser = async (req, res) => {
  try {
    
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        success: false,
        message: "Authentication required. Please log in again."
      });
    }

    const userId = req.user.id;

    const [users] = await pool.query(
      "SELECT id, name, email, role, meta, photo,employee_id, createdAt, updatedAt FROM users WHERE id = ?",
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const user = users[0];
    
    // Parse meta if it's a string
    if (typeof user.meta === 'string') {
      try {
        user.meta = JSON.parse(user.meta);
      } catch (parseError) {
        console.error('Error parsing user meta:', parseError);
        user.meta = {};
      }
    }

    res.json({
      success: true,
      user: user
    });
  } catch (err) {
    console.error("Get current user error:", err);
    res.status(500).json({
      success: false,
      message: "Error fetching user data",
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  }
};