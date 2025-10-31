const express = require('express');
const router = express.Router();
const employeeController = require('../controllers/employeeController');
const attendanceController = require('../controllers/AttendanceController');
const authController = require('../controllers/authController');

router.get('/', employeeController.getAllEmployees);
router.get('/:id', employeeController.getEmployeeById);
router.post('/', employeeController.createEmployee);
router.put('/:id', employeeController.updateEmployee);
router.delete('/:id', employeeController.deleteEmployee);
// router.put('/:id/salary', employeeController.updateEmployeeSalary);

// router.get('/', attendanceController.getEmployees);
router.get('/with-attendance', attendanceController.getEmployeesWithAttendance);
// router.post('/', attendanceController.addEmployee);
// router.put('/:id', attendanceController.updateEmployee);
// router.delete('/:id', attendanceController.deleteEmployee);

// Attendance routes
router.get('/attendance/summary', attendanceController.getAttendanceSummary);
router.post('/attendance/mark', attendanceController.markAttendance);
router.post('/attendance/overtime', attendanceController.addOvertime);
router.get('/attendance/history/:employeeId', attendanceController.getAttendanceHistory);
router.put('/attendance/:id', attendanceController.updateAttendance);
router.delete('/attendance/:id', attendanceController.deleteAttendance);
router.get('/attendance/today',attendanceController.todayAttendance);
router.get('/attendance/mark',attendanceController.markAttendance);

// Invitation routes
router.post('/:id/send-invite', employeeController.sendStaffInvite);
router.get('/validate-invitation', employeeController.validateInvitation);
router.post('/complete-invitation', employeeController.completeInvitation);

router.post('/import', 
  employeeController.upload.single('file'), 
  employeeController.importEmployees
);

router.get('/send-reminders', async (req, res) => {
  try {
    const result = await checkAndSendReminderNotifications();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to send reminders',
      error: error.message
    });
  }
});

// router.get('/trigger-reminder', attendanceController.triggerReminderManually);

// Auth routes
// router.post('/auth/create-password', authController.createPassword);

module.exports = router;
