const express = require("express");
const router = express.Router();
const deliveryController = require("../controllers/deliveryController");

// Get all challans
router.get("/", deliveryController.getAllChallans);

// Create a new challan
router.post("/", deliveryController.createChallan);

module.exports = router;
