const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const auth = require('../middleware/authMiddleware');

// All routes require authentication
router.use(auth);

router.get('/', notificationController.getNotifications);
router.get('/count', notificationController.getNotificationCount);
router.put('/:id/read', notificationController.markAsRead);
router.put('/read-all', notificationController.markAllAsRead);
router.delete('/read', notificationController.deleteAllRead);
router.delete('/:id', notificationController.deleteNotification);
router.get('/all', notificationController.getAllNotifications);

module.exports = router;