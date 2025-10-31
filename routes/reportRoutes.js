const express = require("express");
const router = express.Router();
const { getReportSummary } = require("../controllers/reportController");

router.get("/summary", getReportSummary);

module.exports = router;
