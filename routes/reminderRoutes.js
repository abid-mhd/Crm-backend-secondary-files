const express = require('express');
const router = express.Router();
const employeeController = require('../controllers/employeeController');

// Get reminder system status
router.get('/status', async (req, res) => {
  try {
    const status = await employeeController.getReminderStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting reminder status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get reminder status',
      error: error.message
    });
  }
});

// Manually trigger check-in reminders
router.post('/trigger-checkin', async (req, res) => {
  try {
    const { employeeId } = req.body;
    const result = await employeeController.sendCheckinReminder(req, res);
  } catch (error) {
    console.error('Error triggering check-in reminders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger check-in reminders',
      error: error.message
    });
  }
});

// Manually trigger checkout reminders
router.post('/trigger-checkout', async (req, res) => {
  try {
    const result = await employeeController.reminderScheduler.sendDynamicCheckoutReminders();
    res.json({
      success: true,
      message: 'Checkout reminders triggered successfully',
      data: result
    });
  } catch (error) {
    console.error('Error triggering checkout reminders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger checkout reminders',
      error: error.message
    });
  }
});

// Debug endpoint to see what's happening
router.get('/debug', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const currentTime = new Date().toLocaleTimeString('en-IN', { 
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    // Get employees without checkout
    const employeesWithoutCheckout = await employeeController.reminderScheduler.getEmployeesWithoutCheckout();
    
    // Get scheduler status
    const schedulerStatus = employeeController.reminderScheduler.getSchedulerStatus();

    res.json({
      success: true,
      debugInfo: {
        currentTime: currentTime,
        today: today,
        schedulerRunning: employeeController.reminderScheduler.isRunning,
        workingHours: schedulerStatus.workingHours,
        workingMinutes: schedulerStatus.workingMinutes,
        finalReminderMinutes: schedulerStatus.finalReminderMinutes,
        employeesWithoutCheckout: employeesWithoutCheckout.length,
        cronJobs: {
          checkin: schedulerStatus.checkinCron,
          checkout: '*/5 12-22 * * *' // Extended hours
        },
        employees: employeesWithoutCheckout.map(emp => ({
          id: emp.id,
          name: emp.employeeName,
          checkin: emp.check_in,
          calculatedCheckout: employeeController.reminderScheduler.calculateCheckoutTime(emp.check_in, schedulerStatus.workingHours)
        }))
      }
    });
  } catch (error) {
    console.error('Error in reminder debug:', error);
    res.status(500).json({
      success: false,
      message: 'Debug error',
      error: error.message
    });
  }
});

// Start/Stop reminder scheduler
router.post('/scheduler/start', async (req, res) => {
  try {
    const status = await employeeController.reminderScheduler.start();
    res.json({
      success: true,
      message: 'Reminder scheduler started',
      data: status
    });
  } catch (error) {
    console.error('Error starting scheduler:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start scheduler',
      error: error.message
    });
  }
});

router.post('/scheduler/stop', async (req, res) => {
  try {
    const status = employeeController.reminderScheduler.stop();
    res.json({
      success: true,
      message: 'Reminder scheduler stopped',
      data: status
    });
  } catch (error) {
    console.error('Error stopping scheduler:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to stop scheduler',
      error: error.message
    });
  }
});

module.exports = router;