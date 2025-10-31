const express = require("express");
const router = express.Router();
const { getAllPaymentsIn } = require("../controllers/paymentInReportController");

router.get("/", getAllPaymentsIn);

module.exports = router;
