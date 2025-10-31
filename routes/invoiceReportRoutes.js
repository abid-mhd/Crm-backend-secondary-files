const express = require('express');
const router = express.Router();
const invoiceReportController = require('../controllers/invoiceReportController');

// Get all invoices with filters
router.get('/invoices', invoiceReportController.getAllInvoices);

// Get invoice statistics for cards and chart
router.get('/invoice-stats', invoiceReportController.getInvoiceStats);

// Get filter options
router.get('/filter-options', invoiceReportController.getFilterOptions);

module.exports = router;