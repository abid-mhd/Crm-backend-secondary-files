const db = require("../config/db");
const cronController = require("../controllers/cronController");

async function runBackfill(startDate, endDate) {
  console.log('🚀 Starting standalone backfill attendance...');
  
  try {
    const req = {
      body: {
        startDate,
        endDate
      }
    };
    
    await cronController.backfillMissingAttendance(req);
    console.log('✅ Backfill attendance completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Backfill attendance failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const startDate = args[0] || null;
  const endDate = args[1] || null;
  
  runBackfill(startDate, endDate);
}

module.exports = runBackfill;