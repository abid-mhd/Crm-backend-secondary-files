const db = require("../config/db");
const cronController = require("../controllers/cronController");

async function runDailyAbsentMarking() {
  console.log('🚀 Starting standalone daily absent marking...');
  
  try {
    await cronController.dailyAbsentMarking();
    console.log('✅ Daily absent marking completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Daily absent marking failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  runDailyAbsentMarking();
}

module.exports = runDailyAbsentMarking;