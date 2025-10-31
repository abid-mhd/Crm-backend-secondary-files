// routes/partyReportRoutes.js
const express = require('express');
const router = express.Router();
const partyReportController = require('../controllers/partyReportController');

// Party Reports Routes
router.get('/party-statement', partyReportController.getPartyStatement);
router.get('/party-pnl', partyReportController.getPartyWisePnL);
router.get('/outstanding-receivables', partyReportController.getOutstandingReceivables);
router.get('/outstanding-payables', partyReportController.getOutstandingPayables);
router.get('/party-ledger-summary', partyReportController.getPartyLedgerSummary);
router.get('/top-customers', partyReportController.getTopCustomersBySales);
router.get('/export', partyReportController.exportPartyReport);

module.exports = router;