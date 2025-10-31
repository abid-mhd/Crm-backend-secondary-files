const express = require("express");
const router = express.Router();
const proformaController = require("../controllers/ProformaController");

// Proforma Invoice Routes
router.get('/', proformaController.list);
router.get('/:id', proformaController.get);
router.post('/', proformaController.create);
router.put('/:id', proformaController.update);
router.delete('/:id', proformaController.delete);
router.post('/:id/convert-to-sales', proformaController.convertToSales);

module.exports = router;