const express = require('express');
const router = express.Router();
const crmController = require('../controllers/crmDashboardController');

router.get('/dashboard', crmController.getCRMDashboardData);
router.get('/dashboard/invoice-overview', crmController.getInvoiceOverview);
router.get('/dashboard/invoice-status-summary', crmController.getInvoiceStatusSummary);
router.get('/dashboard/employee-attendance-analytics', crmController.getEmployeeAttendanceAnalytics);
router.get('/dashboard/items', crmController.getItemsWithPagination);
router.get('/dashboard/sales-performance', crmController.getSalesPerformanceWithPagination);
router.get('/dashboard/parties-report', crmController.getPartiesReportWithPagination);

module.exports = router;