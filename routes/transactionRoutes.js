const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const authMiddleware = require('../middleware/authMiddleware');


// Transaction routes
router.get('/employee/:employeeId', transactionController.getEmployeeTransactions);
// router.get('/all', transactionController.getAllTransactions);
// router.get('/recent', transactionController.getRecentTransactions);
router.get('/:id', transactionController.getTransactionById);
router.post('/',  transactionController.createTransaction);
router.put('/:id', transactionController.updateTransaction);
router.delete('/:id', transactionController.deleteTransaction);
router.get('/summary/employee/:employeeId', transactionController.getEmployeeTransactionSummary);

module.exports = router;