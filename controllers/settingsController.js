const db = require("../config/db");
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// Configure multer for file uploads
const storage = multer.memoryStorage(); // Change to memory storage for base64

const upload = multer({
  storage: storage, // Use memory storage instead of disk storage
  limits: {
    fileSize: 2 * 1024 * 1024 // 2MB limit
  },
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Helper function to get user ID
const getUserId = (req) => {
  console.log('Request user in settings:', req.user);
  if (!req.user || !req.user.id) {
    throw new Error('User not authenticated. Please log in again.');
  }
  return req.user.id;
};

// Validation functions
const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validatePhone = (phone) => {
  const phoneRegex = /^\+?[\d\s\-\(\)]{10,}$/;
  return phoneRegex.test(phone);
};

// Add this function to validate JSON before saving
const validateAndStringify = (value) => {
  if (typeof value === 'string') {
    // If it's already a string, try to parse it to validate it's proper JSON
    try {
      JSON.parse(value);
      return value; // It's valid JSON string
    } catch (error) {
      // If it's not valid JSON, treat it as a regular string and wrap it
      return JSON.stringify(value);
    }
  } else {
    // For non-string values, stringify them
    try {
      return JSON.stringify(value);
    } catch (error) {
      console.error('Error stringifying value:', value, error);
      throw new Error('Invalid value for JSON storage');
    }
  }
};

// Safe JSON parsing function
const safeJsonParse = (str, defaultValue = null) => {
  if (!str || str === 'null' || str === 'undefined') return defaultValue;
  try {
    return JSON.parse(str);
  } catch (error) {
    console.error('JSON parse error:', error, 'for string:', str);
    return defaultValue;
  }
};

// Check email uniqueness
const checkEmailUnique = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { email, currentUserId } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    if (!validateEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Invalid email format"
      });
    }

    const [users] = await db.execute(
      `SELECT id FROM users WHERE email = ? AND id != ?`,
      [email, currentUserId || userId]
    );

    res.json({
      success: true,
      isUnique: users.length === 0
    });
  } catch (err) {
    console.error("Error checking email uniqueness:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error checking email" 
    });
  }
};

// Get all settings for a user
const getUserSettings = async (req, res) => {
  try {
    const userId = getUserId(req);
    console.log('Fetching settings for user ID:', userId);

    const [settings] = await db.execute(
      `SELECT setting_type, setting_key, setting_value 
       FROM settings 
       WHERE user_id = ? 
       ORDER BY setting_type, setting_key`,
      [userId]
    );

    // Transform settings into organized structure
    const organizedSettings = {};
    settings.forEach(setting => {
      if (!organizedSettings[setting.setting_type]) {
        organizedSettings[setting.setting_type] = {};
      }
      
      // Use safe JSON parsing with fallback to raw value
      const parsedValue = safeJsonParse(setting.setting_value, setting.setting_value);
      organizedSettings[setting.setting_type][setting.setting_key] = parsedValue;
    });

    res.json({
      success: true,
      data: organizedSettings
    });
  } catch (err) {
    console.error("Error fetching user settings:", err);
    res.status(500).json({ 
      success: false, 
      message: "Database error", 
      error: err.message 
    });
  }
};

// Get specific setting type
const getSettingsByType = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { type } = req.params;

    console.log('Fetching', type, 'settings for user ID:', userId);

    const [settings] = await db.execute(
      `SELECT setting_key, setting_value 
       FROM settings 
       WHERE user_id = ? AND setting_type = ?`,
      [userId, type]
    );

    if (settings.length === 0) {
      return res.json({
        success: true,
        data: {}
      });
    }

    const settingsData = {};
    settings.forEach(setting => {
      // Use safe JSON parsing with fallback to raw value
      const parsedValue = safeJsonParse(setting.setting_value, setting.setting_value);
      settingsData[setting.setting_key] = parsedValue;
    });

    res.json({
      success: true,
      data: settingsData
    });
  } catch (err) {
    console.error("Error fetching settings by type:", err);
    res.status(500).json({ 
      success: false, 
      message: "Database error", 
      error: err.message 
    });
  }
};

// Update settings
const updateSettings = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { type, key, value } = req.body;

    console.log('Updating settings for user ID:', userId, type, key, value);

    if (!type || !key || value === undefined) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: type, key, value"
      });
    }

    // Validate personal_info data
    if (type === 'profile' && key === 'personal_info') {
      if (value.email && !validateEmail(value.email)) {
        return res.status(400).json({
          success: false,
          message: "Invalid email format"
        });
      }

      if (value.phone && !validatePhone(value.phone)) {
        return res.status(400).json({
          success: false,
          message: "Invalid phone number format"
        });
      }

      // Check email uniqueness
      if (value.email) {
        const [users] = await db.execute(
          `SELECT id FROM users WHERE email = ? AND id != ?`,
          [value.email, userId]
        );

        if (users.length > 0) {
          return res.status(400).json({
            success: false,
            message: "Email is already in use by another account"
          });
        }

        // Update email in users table as well
        await db.execute(
          'UPDATE users SET email = ?, updatedAt = NOW() WHERE id = ?',
          [value.email, userId]
        );
      }
    }

    // Check if setting exists
    const [existing] = await db.execute(
      `SELECT id, setting_value FROM settings WHERE user_id = ? AND setting_type = ? AND setting_key = ?`,
      [userId, type, key]
    );

    // Use the validation function to ensure proper JSON
    const stringValue = validateAndStringify(value);

    if (existing.length > 0) {
      await db.execute(
        `UPDATE settings SET setting_value = ?, updated_at = NOW() 
         WHERE user_id = ? AND setting_type = ? AND setting_key = ?`,
        [stringValue, userId, type, key]
      );
    } else {
      await db.execute(
        `INSERT INTO settings (user_id, setting_type, setting_key, setting_value, created_at, updated_at) 
         VALUES (?, ?, ?, ?, NOW(), NOW())`,
        [userId, type, key, stringValue]
      );
    }

    res.json({
      success: true,
      message: "Settings updated successfully"
    });
  } catch (err) {
    console.error("Error updating settings:", err);
    
    if (err.message.includes('Invalid value for JSON storage')) {
      return res.status(400).json({
        success: false,
        message: "Invalid data format. Please check your input.",
        error: err.message
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: "Database error", 
      error: err.message 
    });
  }
};

// Update multiple settings at once
const updateMultipleSettings = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { settings } = req.body;

    console.log('Updating multiple settings for user ID:', userId, settings);

    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({
        success: false,
        message: "Invalid settings format"
      });
    }

    const updates = [];
    
    for (const [type, typeSettings] of Object.entries(settings)) {
      for (const [key, value] of Object.entries(typeSettings)) {
        try {
          const stringValue = validateAndStringify(value);
          updates.push({ type, key, value: stringValue });
        } catch (error) {
          console.error(`Invalid value for ${type}.${key}:`, value);
          return res.status(400).json({
            success: false,
            message: `Invalid value for ${key}: ${error.message}`
          });
        }
      }
    }

    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      for (const update of updates) {
        const [existing] = await connection.execute(
          `SELECT id FROM settings WHERE user_id = ? AND setting_type = ? AND setting_key = ?`,
          [userId, update.type, update.key]
        );

        if (existing.length > 0) {
          await connection.execute(
            `UPDATE settings SET setting_value = ?, updated_at = NOW() 
             WHERE user_id = ? AND setting_type = ? AND setting_key = ?`,
            [update.value, userId, update.type, update.key]
          );
        } else {
          await connection.execute(
            `INSERT INTO settings (user_id, setting_type, setting_key, setting_value, created_at, updated_at) 
             VALUES (?, ?, ?, ?, NOW(), NOW())`,
            [userId, update.type, update.key, update.value]
          );
        }
      }

      await connection.commit();
      res.json({
        success: true,
        message: "Settings updated successfully"
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error("Error updating multiple settings:", err);
    
    if (err.message.includes('Invalid JSON') || err.message.includes('JSON')) {
      return res.status(400).json({
        success: false,
        message: "Invalid data format. Please check your input.",
        error: err.message
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: "Database error", 
      error: err.message 
    });
  }
};

// Upload avatar - BASE64 VERSION that saves to database tables
const uploadAvatar = async (req, res) => {
  try {
    const userId = getUserId(req);
    
    console.log('Uploading avatar for user ID:', userId);

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No avatar file provided"
      });
    }

    // Convert file buffer to base64
    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;
    const base64Data = `data:${mimeType};base64,${base64Image}`;

    // Update avatar in users table as base64
    await db.execute(
      'UPDATE users SET photo = ?, updatedAt = NOW() WHERE id = ?',
      [base64Data, userId]
    );

    // Also update avatar in settings table for consistency
    const [existingSettings] = await db.execute(
      `SELECT setting_value FROM settings 
       WHERE user_id = ? AND setting_type = 'profile' AND setting_key = 'personal_info'`,
      [userId]
    );

    let personalInfo = {};

    if (existingSettings.length > 0) {
      personalInfo = safeJsonParse(existingSettings[0].setting_value, {});
    }

    // Update personal_info with new avatar (store as base64)
    const updatedPersonalInfo = {
      ...personalInfo,
      avatar: base64Data,
      avatarMimeType: mimeType
    };

    const stringifiedPersonalInfo = validateAndStringify(updatedPersonalInfo);

    if (existingSettings.length > 0) {
      await db.execute(
        `UPDATE settings SET setting_value = ?, updated_at = NOW() 
         WHERE user_id = ? AND setting_type = 'profile' AND setting_key = 'personal_info'`,
        [stringifiedPersonalInfo, userId]
      );
    } else {
      await db.execute(
        `INSERT INTO settings (user_id, setting_type, setting_key, setting_value, created_at, updated_at) 
         VALUES (?, 'profile', 'personal_info', ?, NOW(), NOW())`,
        [userId, stringifiedPersonalInfo]
      );
    }

    res.json({
      success: true,
      message: "Avatar uploaded successfully",
      data: {
        avatarUrl: base64Data, // Return base64 data
        personalInfo: updatedPersonalInfo
      }
    });
  } catch (err) {
    console.error("Error uploading avatar:", err);
    res.status(500).json({ 
      success: false, 
      message: "Database error", 
      error: err.message 
    });
  }
};

// Get user avatar - BASE64 VERSION
const getUserAvatar = async (req, res) => {
  try {
    const userId = getUserId(req);

    // First try to get from users table
    const [users] = await db.execute(
      `SELECT photo FROM users WHERE id = ?`,
      [userId]
    );

    if (users.length > 0 && users[0].photo) {
      const photoData = users[0].photo;
      
      // Check if it's base64 data (starts with data:image/)
      if (photoData.startsWith('data:image/')) {
        return res.json({
          success: true,
          data: {
            avatarUrl: photoData,
            isBase64: true
          }
        });
      } else {
        // It's a URL, return as is
        return res.json({
          success: true,
          data: {
            avatarUrl: photoData,
            isBase64: false
          }
        });
      }
    }

    // If not in users table, check settings table
    const [settings] = await db.execute(
      `SELECT setting_value FROM settings 
       WHERE user_id = ? AND setting_type = 'profile' AND setting_key = 'personal_info'`,
      [userId]
    );

    if (settings.length > 0) {
      const personalInfo = safeJsonParse(settings[0].setting_value, {});
      if (personalInfo.avatar) {
        return res.json({
          success: true,
          data: {
            avatarUrl: personalInfo.avatar,
            isBase64: personalInfo.avatar.startsWith('data:image/')
          }
        });
      }
    }

    // No avatar found
    res.json({
      success: true,
      data: {
        avatarUrl: null
      }
    });
  } catch (err) {
    console.error("Error fetching user avatar:", err);
    res.status(500).json({ 
      success: false, 
      message: "Database error", 
      error: err.message 
    });
  }
};

// Delete user avatar - BASE64 VERSION
const deleteAvatar = async (req, res) => {
  try {
    const userId = getUserId(req);

    // Get current avatar to check if it's a file that needs deletion
    const [users] = await db.execute(
      `SELECT photo FROM users WHERE id = ?`,
      [userId]
    );

    if (users.length > 0 && users[0].photo) {
      const currentPhoto = users[0].photo;
      
      // Only delete file from filesystem if it's a URL, not base64
      if (!currentPhoto.startsWith('data:image/')) {
        const filename = currentPhoto.split('/').pop();
        const filePath = path.join('uploads', 'avatars', filename);

        // Delete file from filesystem
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }
    }

    // Remove avatar from users table
    await db.execute(
      'UPDATE users SET photo = NULL, updatedAt = NOW() WHERE id = ?',
      [userId]
    );

    // Remove avatar from settings table
    const [settings] = await db.execute(
      `SELECT setting_value FROM settings 
       WHERE user_id = ? AND setting_type = 'profile' AND setting_key = 'personal_info'`,
      [userId]
    );

    if (settings.length > 0) {
      const personalInfo = safeJsonParse(settings[0].setting_value, {});
      delete personalInfo.avatar;
      delete personalInfo.avatarMimeType;

      const stringifiedPersonalInfo = validateAndStringify(personalInfo);

      await db.execute(
        `UPDATE settings SET setting_value = ?, updated_at = NOW() 
         WHERE user_id = ? AND setting_type = 'profile' AND setting_key = 'personal_info'`,
        [stringifiedPersonalInfo, userId]
      );
    }

    res.json({
      success: true,
      message: "Avatar deleted successfully"
    });
  } catch (err) {
    console.error("Error deleting avatar:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error deleting avatar", 
      error: err.message 
    });
  }
};

// Multer middleware for file upload
const uploadMiddleware = upload.single('avatar');

// Verify current password
const verifyCurrentPassword = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { password } = req.body;

    console.log('Verifying password for user ID:', userId);

    const [users] = await db.execute(
      `SELECT id, password FROM users WHERE id = ?`,
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const user = users[0];
    const isBcryptHash = /^\$2[aby]\$/.test(user.password);
    
    let isValid = false;
    
    if (isBcryptHash) {
      isValid = await bcrypt.compare(password, user.password);
    } else {
      isValid = (password === user.password);
    }

    res.json({
      success: true,
      isValid: isValid,
      passwordFormat: isBcryptHash ? 'bcrypt' : 'plain_or_other'
    });
  } catch (err) {
    console.error("Error verifying password:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error verifying password" 
    });
  }
};

// Update password in settings controller (for security settings)
const updatePassword = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { currentPassword, newPassword } = req.body;

    console.log('Changing password via settings for user ID:', userId);

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required"
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters long"
      });
    }

    // Fetch user password
    const [users] = await db.execute(
      `SELECT id, password FROM users WHERE id = ?`,
      [userId]
    );

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

    // Hash new password
    const newHashedPassword = await bcrypt.hash(newPassword, 10);
    
    // Update password in database
    await db.execute(
      'UPDATE users SET password = ?, updatedAt = NOW() WHERE id = ?',
      [newHashedPassword, userId]
    );

    res.json({
      success: true,
      message: "Password updated successfully"
    });
  } catch (err) {
    console.error("Error updating password:", err);
    res.status(500).json({
      success: false,
      message: "Error updating password",
      error: err.message
    });
  }
};

// Update security settings
const updateSecuritySettings = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { twoFactorAuth } = req.body;

    console.log('Updating security settings for user ID:', userId);

    const [existing] = await db.execute(
      `SELECT id FROM settings WHERE user_id = ? AND setting_type = 'security' AND setting_key = 'twoFactorAuth'`,
      [userId]
    );

    const stringValue = validateAndStringify(twoFactorAuth);

    if (existing.length > 0) {
      await db.execute(
        `UPDATE settings SET setting_value = ?, updated_at = NOW() 
         WHERE user_id = ? AND setting_type = 'security' AND setting_key = 'twoFactorAuth'`,
        [stringValue, userId]
      );
    } else {
      await db.execute(
        `INSERT INTO settings (user_id, setting_type, setting_key, setting_value, created_at, updated_at) 
         VALUES (?, 'security', 'twoFactorAuth', ?, NOW(), NOW())`,
        [userId, stringValue]
      );
    }

    res.json({
      success: true,
      message: "Security settings updated successfully"
    });
  } catch (err) {
    console.error("Error updating security settings:", err);
    res.status(500).json({ 
      success: false, 
      message: "Database error", 
      error: err.message 
    });
  }
};

// Get security settings
const getSecuritySettings = async (req, res) => {
  try {
    const userId = getUserId(req);

    console.log('Fetching security settings for user ID:', userId);

    const [settings] = await db.execute(
      `SELECT setting_key, setting_value 
       FROM settings 
       WHERE user_id = ? AND setting_type = 'security'`,
      [userId]
    );

    const securitySettings = {};
    settings.forEach(setting => {
      securitySettings[setting.setting_key] = safeJsonParse(setting.setting_value, setting.setting_value);
    });

    res.json({
      success: true,
      data: securitySettings
    });
  } catch (err) {
    console.error("Error fetching security settings:", err);
    res.status(500).json({ 
      success: false, 
      message: "Database error", 
      error: err.message 
    });
  }
};

// Get user profile from users table
const getUserProfile = async (req, res) => {
  try {
    const userId = getUserId(req);

    const [users] = await db.execute(
      `SELECT id, email, name, photo FROM users WHERE id = ?`,
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const user = users[0];
    res.json({
      success: true,
      data: {
        email: user.email,
        name: user.name,
        photo: user.photo
      }
    });
  } catch (err) {
    console.error("Error fetching user profile:", err);
    res.status(500).json({ 
      success: false, 
      message: "Database error", 
      error: err.message 
    });
  }
};

// Update user profile in users table
const updateUserProfile = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { email, name } = req.body;

    console.log('Updating user profile for user ID:', userId, { email, name });

    if (!email && !name) {
      return res.status(400).json({
        success: false,
        message: "No data provided for update"
      });
    }

    // Build update query dynamically
    const updates = [];
    const params = [];

    if (email) {
      // Validate email
      if (!validateEmail(email)) {
        return res.status(400).json({
          success: false,
          message: "Invalid email format"
        });
      }

      // Check email uniqueness
      const [emailUsers] = await db.execute(
        `SELECT id FROM users WHERE email = ? AND id != ?`,
        [email, userId]
      );

      if (emailUsers.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Email is already in use by another account"
        });
      }

      updates.push('email = ?');
      params.push(email);
    }

    if (name) {
      // Validate name
      if (name.trim().length === 0) {
        return res.status(400).json({
          success: false,
          message: "Name cannot be empty"
        });
      }

      updates.push('name = ?');
      params.push(name.trim());
    }

    // Add updatedAt and user ID
    updates.push('updatedAt = NOW()');
    params.push(userId);

    const query = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;

    await db.execute(query, params);

    res.json({
      success: true,
      message: "User profile updated successfully"
    });
  } catch (err) {
    console.error("Error updating user profile:", err);
    res.status(500).json({ 
      success: false, 
      message: "Database error", 
      error: err.message 
    });
  }
};

// Check name uniqueness
const checknameUnique = async (req, res) => {
  try {
    const userId = getUserId(req);
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "name is required"
      });
    }

    const [users] = await db.execute(
      `SELECT id FROM users WHERE name = ? AND id != ?`,
      [name, userId]
    );

    res.json({
      success: true,
      isUnique: users.length === 0
    });
  } catch (err) {
    console.error("Error checking name uniqueness:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error checking name" 
    });
  }
};

// Clean up invalid settings data (utility function)
const cleanupInvalidSettings = async (req, res) => {
  try {
    console.log('Cleaning up invalid settings data...');
    
    // Find settings with invalid JSON
    const [invalidSettings] = await db.execute(
      `SELECT id, user_id, setting_type, setting_key, setting_value 
       FROM settings 
       WHERE setting_value IS NOT NULL 
       AND setting_value != ''`
    );

    let fixedCount = 0;
    let deletedCount = 0;

    for (const setting of invalidSettings) {
      try {
        // Try to parse the setting value
        safeJsonParse(setting.setting_value);
        // If it parses successfully, it's valid
      } catch (parseError) {
        console.log(`Found invalid JSON in setting ${setting.id}:`, setting.setting_value);
        
        // Try to fix common issues
        let fixedValue = setting.setting_value;
        
        // Remove any invalid characters at the start
        fixedValue = fixedValue.replace(/^[^{[]*/, '');
        
        // Ensure it starts with { or [
        if (!fixedValue.startsWith('{') && !fixedValue.startsWith('[')) {
          // If it's a simple string value, wrap it in quotes
          if (fixedValue && !fixedValue.includes('"')) {
            fixedValue = `"${fixedValue}"`;
          } else {
            // If we can't fix it, delete the setting
            await db.execute('DELETE FROM settings WHERE id = ?', [setting.id]);
            console.log(`Deleted invalid setting ${setting.id}`);
            deletedCount++;
            continue;
          }
        }

        try {
          // Try to parse the fixed value
          safeJsonParse(fixedValue);
          
          // Update with fixed value
          await db.execute(
            'UPDATE settings SET setting_value = ? WHERE id = ?',
            [fixedValue, setting.id]
          );
          fixedCount++;
          console.log(`Fixed setting ${setting.id}`);
        } catch (secondError) {
          // If still invalid, delete it
          await db.execute('DELETE FROM settings WHERE id = ?', [setting.id]);
          deletedCount++;
          console.log(`Deleted invalid setting ${setting.id} after failed fix attempt`);
        }
      }
    }

    const result = {
      success: true,
      message: `Cleanup completed: ${fixedCount} settings fixed, ${deletedCount} settings deleted`,
      fixedCount,
      deletedCount
    };

    if (req && res) {
      res.json(result);
    } else {
      return result;
    }
    
  } catch (error) {
    console.error('Error during cleanup:', error);
    if (req && res) {
      res.status(500).json({
        success: false,
        message: "Cleanup failed",
        error: error.message
      });
    } else {
      throw error;
    }
  }
};

// Export all functions
module.exports = {
  checkEmailUnique,
  getUserSettings,
  getSettingsByType,
  updateSettings,
  updateMultipleSettings,
  uploadAvatar,
  getUserAvatar,
  deleteAvatar,
  uploadMiddleware,
  verifyCurrentPassword,
  updatePassword,
  updateSecuritySettings,
  getSecuritySettings,
  getUserProfile,
  updateUserProfile,
  checknameUnique,
  cleanupInvalidSettings,
  validateAndStringify,
  safeJsonParse
};