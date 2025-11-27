const express = require('express');
const router = express.Router();
const cronController = require('../controllers/cronController');

// Manual triggers for testing
router.post('/cron/manual-trigger', cronController.manualTrigger);
router.get('/cron/daily-absent', cronController.dailyAbsentMarking);
router.post('/cron/backfill', cronController.backfillMissingAttendance);
router.get('/cron/missing-report', cronController.getMissingAttendanceReport);

module.exports = router;