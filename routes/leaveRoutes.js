const express = require('express');
const router = express.Router();
const leaveController = require('../controllers/leaveController');
const auth = require('../middleware/authMiddleware');

// Employee routes (require authentication)
router.get('/my-leaves', auth, leaveController.getMyLeaves);
router.get('/my-balance', auth, leaveController.getMyLeaveBalance);
router.post('/apply', auth, leaveController.applyLeave);
router.put('/update/:id', auth, leaveController.updateLeave);
router.delete('/cancel/:id', auth, leaveController.cancelLeave);
router.get('/statistics', auth, leaveController.getLeaveStatistics);
router.get('/existing-balance', auth, leaveController.getExistingLeaveBalance);
router.post('/set-balance-all', auth, leaveController.setLeaveBalanceForAll);
router.delete('/balance/clear', auth, leaveController.clearLeaveBalanceForAll);

// Admin routes (require admin role)
router.get('/all', auth, leaveController.getAllLeaves);
router.put('/status/:id', auth, leaveController.updateLeaveStatus);

module.exports = router;