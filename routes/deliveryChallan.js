const express = require("express");
const router = express.Router();
const deliveryController = require("../controllers/deliveryController");

router.get('/', deliveryController.list);
router.get('/stats', deliveryController.getStats);
router.get('/:id', deliveryController.get);
router.get('/:id/balance', deliveryController.balance);
router.post('/', deliveryController.create);
router.put('/:id', deliveryController.update);
router.delete('/:id', deliveryController.delete);
router.patch('/:id/status', deliveryController.updateStatus);

module.exports = router;
