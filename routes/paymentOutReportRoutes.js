const express = require("express");
const router = express.Router();
const { getAllPaymentsOut } = require("../controllers/paymentOutReportController");

router.get("/", getAllPaymentsOut);

module.exports = router;
