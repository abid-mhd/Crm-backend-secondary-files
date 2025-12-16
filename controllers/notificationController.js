const NotificationService = require('../services/notificationService');
const db = require('../config/db');

// Get user notifications
const getNotifications = async (req, res) => {
  try {
    const userId = req.user.id;
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const { notifications, unreadCount } = await NotificationService.getUserNotifications(
      userId, 
      parseInt(limit), 
      parseInt(offset)
    );

    res.json({
      success: true,
      data: {
        notifications,
        unreadCount,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          hasMore: notifications.length === parseInt(limit)
        }
      }
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch notifications'
    });
  }
};

// Mark notification as read
const markAsRead = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    await NotificationService.markAsRead(id, userId);

    res.json({
      success: true,
      message: 'Notification marked as read'
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark notification as read'
    });
  }
};

// Mark all notifications as read
const markAllAsRead = async (req, res) => {
  try {
    const userId = req.user.id;

    await NotificationService.markAllAsRead(userId);

    res.json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark all notifications as read'
    });
  }
};

// Delete notification
const deleteNotification = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    await NotificationService.deleteNotification(id, userId);

    res.json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete notification'
    });
  }
};

// Get notification count
const getNotificationCount = async (req, res) => {
  try {
    const userId = req.user.id;

    const [unreadCount] = await db.query(
      `SELECT COUNT(*) as count FROM notifications 
       WHERE user_id = ? AND is_read = FALSE`,
      [userId]
    );

    res.json({
      success: true,
      data: {
        unreadCount: unreadCount[0].count
      }
    });
  } catch (error) {
    console.error('Error fetching notification count:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch notification count'
    });
  }
};

const getAllNotifications = async (req, res) => {
  try {
    const userId = req.user.id;
    const { 
      page = 1, 
      limit = 25, 
      filter = 'all', 
      search = '' 
    } = req.query;
    
    const offset = (page - 1) * limit;

    // Build WHERE clause based on filters
    let whereClause = 'WHERE user_id = ?';
    const queryParams = [userId];

    // Apply read/unread filter
    if (filter === 'read') {
      whereClause += ' AND is_read = TRUE';
    } else if (filter === 'unread') {
      whereClause += ' AND is_read = FALSE';
    }

    // Apply search filter if provided
    if (search && search.trim() !== '') {
      whereClause += ` AND (
        title LIKE ? OR 
        message LIKE ? OR
        module LIKE ?
      )`;
      const searchTerm = `%${search.trim()}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm);
    }

    // Get total count for pagination
    const [countResult] = await db.query(
      `SELECT COUNT(*) as total FROM notifications ${whereClause}`,
      queryParams
    );
    
    const total = countResult[0].total;

    // Get notifications with pagination
    const [notifications] = await db.query(
      `SELECT * FROM notifications 
       ${whereClause}
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [...queryParams, parseInt(limit), parseInt(offset)]
    );

    // Get unread count for stats
    const [unreadCountResult] = await db.query(
      `SELECT COUNT(*) as count FROM notifications 
       WHERE user_id = ? AND is_read = FALSE`,
      [userId]
    );

    const unreadCount = unreadCountResult[0].count;
    const readCount = total - unreadCount;

    res.json({
      success: true,
      data: {
        notifications,
        total,
        unreadCount,
        readCount,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(total / limit),
          hasMore: (parseInt(page) * parseInt(limit)) < total
        }
      }
    });
  } catch (error) {
    console.error('Error fetching all notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch notifications'
    });
  }
};

const deleteAllRead = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await db.query(
      'DELETE FROM notifications WHERE user_id = ? AND is_read = TRUE',
      [userId]
    );

    res.json({
      success: true,
      message: 'All read notifications deleted successfully',
      data: {
        deletedCount: result[0].affectedRows
      }
    });
  } catch (error) {
    console.error('Error deleting all read notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete read notifications'
    });
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  getNotificationCount,
  getAllNotifications,
  deleteAllRead
};