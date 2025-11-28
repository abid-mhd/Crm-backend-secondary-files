// routes/employee.js
const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/AttendanceController');
const leavesController = require('../controllers/leaveController');
const authMiddleware = require('../middleware/authMiddleware');

// Apply authentication middleware to all routes
router.use(authMiddleware);

// Employee routes
router.get('/', attendanceController.getEmployees);
router.get('/with-attendance', attendanceController.getEmployeesWithAttendance);
router.post('/', attendanceController.addEmployee);
router.put('/:id', attendanceController.updateEmployee);
router.delete('/:id', attendanceController.deleteEmployee);

// Attendance routes
router.get('/attendance/summary', attendanceController.getAttendanceSummary);
// Payroll routes
router.get('/payroll', attendanceController.getEmployeePayroll);
router.post('/attendance/mark', attendanceController.markAttendance);
router.post('/attendance/overtime', attendanceController.addOvertime);
router.get('/attendance/history/:employeeId', attendanceController.getAttendanceHistory);
router.put('/attendance/:id', attendanceController.updateAttendance);
router.delete('/attendance/:id', attendanceController.deleteAttendance);

// Add to your backend routes
router.get('/attendance/today',attendanceController.todayAttendance);
router.get('/by-period', attendanceController.getAttendanceByPeriod);
router.get('/attendance/non-working-days', attendanceController.getNonWorkingDays);
router.get('/enhanced-report', attendanceController.getEnhancedAttendanceReport);


// Attendance settings routes
router.get('/settings', attendanceController.getAttendanceSettings);
router.post('/attendance/settings', attendanceController.saveAttendanceSettings);

router.get('/my-attendance', attendanceController.getMyAttendance);
router.get('/my-summary',  attendanceController.getMyAttendanceSummary);
router.get('/my-stats',  attendanceController.getMyAttendanceStats);

// Attendance log routes
router.get('/logs/:attendanceId', attendanceController.getAttendanceLogs);
router.get('/logs', attendanceController.getAllAttendanceLogs);
router.get('/logs-stats', attendanceController.getAttendanceLogStats);

module.exports = router;