const express = require('express');
const router = express.Router();
const { getPaymentConfig, updatePaymentConfig } = require('../controllers/paymentController');

router.get('/', getPaymentConfig);
router.put('/', updatePaymentConfig);

module.exports = router;
