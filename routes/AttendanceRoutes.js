// routes/employee.js
const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/AttendanceController');
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

// Attendance settings routes
router.get('/settings', attendanceController.getAttendanceSettings);
router.post('/attendance/settings', attendanceController.saveAttendanceSettings);

router.get('/my-attendance', attendanceController.getMyAttendance);
router.get('/my-summary',  attendanceController.getMyAttendanceSummary);
router.get('/my-stats',  attendanceController.getMyAttendanceStats);

module.exports = router;