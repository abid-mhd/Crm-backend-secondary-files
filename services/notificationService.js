const db = require('../config/db');

class NotificationService {
  // Create notification for specific users
  static async createNotification(notificationData) {
    const { userIds, title, message, type = 'system', module = null, moduleId = null } = notificationData;
    
    try {
      const notifications = userIds.map(userId => [
        userId,
        title,
        message,
        type,
        module,
        moduleId,
        false // is_read
      ]);

      const [result] = await db.query(
        `INSERT INTO notifications (user_id, title, message, type, module, module_id, is_read) 
         VALUES ?`,
        [notifications]
      );

      return result;
    } catch (error) {
      console.error('Error creating notifications:', error);
      throw error;
    }
  }

  // Create leave application notification for HR and Admin users
  static async createLeaveNotification(leaveData) {
    try {
      // Get all HR and Admin users
      const [users] = await db.query(
        `SELECT id FROM users WHERE role IN ('admin', 'hr') `
      );

      if (users.length === 0) {
        console.log('No HR/Admin users found for notification');
        return;
      }

      const userIds = users.map(user => user.id);
      const { employeeName, leaveType, days, id: leaveId } = leaveData;

      const title = 'New Leave Application';
      const message = `${employeeName} has applied for ${leaveType} leave for ${days} day(s)`;
      
      await this.createNotification({
        userIds,
        title,
        message,
        type: 'leave_application',
        module: 'leaves',
        moduleId: leaveId
      });

      console.log(`Leave notification sent to ${userIds.length} users`);
    } catch (error) {
      console.error('Error creating leave notification:', error);
      throw error;
    }
  }

  // Get notifications for a user
  static async getUserNotifications(userId, limit = 20, offset = 0) {
    try {
      const [notifications] = await db.query(
        `SELECT * FROM notifications 
         WHERE user_id = ? 
         ORDER BY created_at DESC 
         LIMIT ? OFFSET ?`,
        [userId, limit, offset]
      );

      const [unreadCount] = await db.query(
        `SELECT COUNT(*) as count FROM notifications 
         WHERE user_id = ? AND is_read = FALSE`,
        [userId]
      );

      return {
        notifications,
        unreadCount: unreadCount[0].count
      };
    } catch (error) {
      console.error('Error fetching notifications:', error);
      throw error;
    }
  }

  // Mark notification as read
  static async markAsRead(notificationId, userId) {
    try {
      const [result] = await db.query(
        `UPDATE notifications SET is_read = TRUE 
         WHERE id = ? AND user_id = ?`,
        [notificationId, userId]
      );

      return result;
    } catch (error) {
      console.error('Error marking notification as read:', error);
      throw error;
    }
  }

  // Mark all notifications as read for a user
  static async markAllAsRead(userId) {
    try {
      const [result] = await db.query(
        `UPDATE notifications SET is_read = TRUE 
         WHERE user_id = ? AND is_read = FALSE`,
        [userId]
      );

      return result;
    } catch (error) {
      console.error('Error marking all notifications as read:', error);
      throw error;
    }
  }

  // Delete notification
  static async deleteNotification(notificationId, userId) {
    try {
      const [result] = await db.query(
        'DELETE FROM notifications WHERE id = ? AND user_id = ?',
        [notificationId, userId]
      );

      return result;
    } catch (error) {
      console.error('Error deleting notification:', error);
      throw error;
    }
  }

   static async createLeaveStatusNotification(employeeUserId, leaveData, status, comments, adminName) {
    try {
      const { leave_type, days, id: leaveId } = leaveData;
      
      let title = '';
      let message = '';
      
      switch (status) {
        case 'Approved':
          title = 'Leave Application Approved';
          message = `Your ${leave_type} leave application for ${days} day(s) has been approved`;
          if (comments) {
            message += `. Comments: ${comments}`;
          }
          break;
          
        case 'Rejected':
          title = 'Leave Application Rejected';
          message = `Your ${leave_type} leave application for ${days} day(s) has been rejected`;
          if (comments) {
            message += `. Reason: ${comments}`;
          }
          break;
          
        default:
          title = 'Leave Application Status Updated';
          message = `Your ${leave_type} leave application status has been updated to ${status}`;
          if (comments) {
            message += `. Note: ${comments}`;
          }
      }
      
      message += ` (by ${adminName})`;
      
      await this.createNotification({
        userIds: [employeeUserId],
        title,
        message,
        type: 'leave_status_update',
        module: 'leaves',
        moduleId: leaveId
      });
      
      console.log(`Leave status notification sent to employee user ${employeeUserId}`);
    } catch (error) {
      console.error('Error creating leave status notification:', error);
      throw error;
    }
  }
}

module.exports = NotificationService;