const express = require("express");
const router = express.Router();
const debitNoteController = require("../controllers/debitNoteController");

router.get("/", debitNoteController.list);
router.get("/:id", debitNoteController.get);
router.post("/", debitNoteController.create);
router.put("/:id", debitNoteController.update);
router.delete("/:id", debitNoteController.delete);
router.get("/:id/balance", debitNoteController.balance);

module.exports = router;