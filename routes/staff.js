const express = require('express');
const router = express.Router();
const staffController = require('../controllers/staffController');
const authMiddleware = require('../middleware/authMiddleware');

// Apply authentication middleware to all routes
router.use(authMiddleware);



// Staff dashboard routes
router.get('/dashboard', staffController.getStaffDashboardData);
router.get('/reports/attendance', staffController.getStaffAttendanceReport);
router.get('/reports/working-hours', staffController.getStaffWorkingHoursReport);
router.get('/reports/leaves', staffController.getStaffLeavesReport);
router.get('/reports/transactions', staffController.getStaffTransactionsReport);

module.exports = router;