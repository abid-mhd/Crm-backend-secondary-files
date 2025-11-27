const cron = require('node-cron');
const cronController = require('../controllers/cronController');

// Helper function to check if today is weekend
function isWeekend() {
  const today = new Date();
  const dayOfWeek = today.getDay();
  return dayOfWeek === 0 || dayOfWeek === 6; // 0 = Sunday, 6 = Saturday
}

// Schedule daily absent marking at 11:30 PM every day EXCEPT weekends
function scheduleDailyAbsentMarking() {
  // Run at 11:30 PM every day (Monday to Friday)
  const task = cron.schedule('0 30 23 * * 1-5', async () => {
    const now = new Date();
    
    // Double check if it's weekend (just in case)
    if (isWeekend()) {
      console.log(`⏭️ CRON [${now.toISOString()}]: Skipping - Today is weekend`);
      return;
    }
    
    console.log(`🕚 CRON [${now.toISOString()}]: Running daily absent marking at 11:30 PM...`);
    
    try {
      await cronController.dailyAbsentMarking();
      console.log(`✅ CRON [${new Date().toISOString()}]: Daily absent marking completed successfully`);
    } catch (error) {
      console.error(`❌ CRON [${new Date().toISOString()}]: Daily absent marking failed:`, error.message);
    }
  }, {
    scheduled: true,
    timezone: "Asia/Kolkata" // Adjust to your timezone
  });

  console.log('⏰ Daily absent marking scheduled for 11:30 PM (Monday to Friday only)');
  return task;
}

// Start the scheduler
function startScheduler() {
  const dailyTask = scheduleDailyAbsentMarking();
  
  return {
    dailyTask
  };
}

module.exports = {
  scheduleDailyAbsentMarking,
  startScheduler,
  isWeekend
};