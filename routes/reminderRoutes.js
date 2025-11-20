const express = require('express');
const router = express.Router();
const employeeController = require('../controllers/employeeController');
const auth = require('../middleware/authMiddleware');

// All routes require authentication
router.use(auth);

// Get reminder status
// router.get('/status', employeeController.getReminderStatus);

// Manual check-in reminder
router.post('/checkin', employeeController.sendCheckinReminder);

// Manual check-out reminder
router.post('/checkout', employeeController.sendCheckoutReminder);

// Test SMS
router.post('/test-sms', employeeController.testSMS);

module.exports = router;