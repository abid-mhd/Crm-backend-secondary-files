const express = require("express");
const router = express.Router();
const bankController = require("../controllers/bankDetailsController");

router.get("/", bankController.getAllBanks);
router.get("/:id", bankController.getBankById);
router.post("/", bankController.createBank);
router.put("/:id", bankController.updateBank);
router.delete("/:id", bankController.deleteBank);

module.exports = router;
