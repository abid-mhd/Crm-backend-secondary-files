// routes/partyReportRoutes.js
const express = require('express');
const router = express.Router();
const partyReportController = require('../controllers/partyReportController');

// Party Reports Routes
router.get('/receivable-ageing', partyReportController.getReceivableAgeingReport);
router.get('/party-by-item', partyReportController.getPartyReportByItem);
router.get('/party-statement', partyReportController.getPartyStatement);
router.get('/party-outstanding', partyReportController.getPartyWiseOutstanding);
router.get('/sales-summary-category', partyReportController.getSalesSummaryCategoryWise);

module.exports = router;