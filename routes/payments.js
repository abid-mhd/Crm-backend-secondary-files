const express = require('express');
const router = express.Router();
const paymentInController = require('../controllers/paymentsController');

router.post('/', paymentInController.createPaymentIn);
router.get('/', paymentInController.getAllPaymentsIn);
router.get('/:id', paymentInController.getPaymentInById);
router.put('/:id', paymentInController.updatePaymentIn);
router.delete('/:id', paymentInController.deletePaymentIn);

module.exports = router;