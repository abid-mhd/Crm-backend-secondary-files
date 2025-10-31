const express = require('express');
const router = express.Router();
const purchaseOrderController = require('../controllers/purchaseOrderController');

// Purchase Order routes
router.get('/', purchaseOrderController.list);
router.get('/:id', purchaseOrderController.get);
router.post('/', purchaseOrderController.create);
router.put('/:id', purchaseOrderController.update);
router.delete('/:id', purchaseOrderController.delete);
router.patch('/:id/status', purchaseOrderController.updateStatus);

module.exports = router;