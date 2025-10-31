// routes/itemReportRoutes.js
const express = require('express');
const router = express.Router();
const itemReportController = require('../controllers/itemReportController');

// Item Reports Routes
router.get('/stock-summary', itemReportController.getStockSummary);
router.get('/low-stock-alert', itemReportController.getLowStockAlert);
router.get('/item-sales', itemReportController.getItemWiseSales);
router.get('/item-purchase', itemReportController.getItemWisePurchase);
router.get('/stock-valuation', itemReportController.getStockValuation);
router.get('/item-movement', itemReportController.getItemMovement);

module.exports = router;