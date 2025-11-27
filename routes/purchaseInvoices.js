const express = require('express');
const router = express.Router();
const purchaseInvoiceController = require('../controllers/purchaseInvoiceController');
const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware);

// Purchase Invoice routes
router.get('/', purchaseInvoiceController.list);
router.get('/:id', purchaseInvoiceController.get);
router.post('/', purchaseInvoiceController.create);
router.put('/:id', purchaseInvoiceController.update);
router.delete('/:id', purchaseInvoiceController.delete);
router.get('/:id/balance', purchaseInvoiceController.balance);

// History routes
router.get('/:id/history', purchaseInvoiceController.getHistory);

module.exports = router;