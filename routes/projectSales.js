const router = require("express").Router();
const {
  getSalesByProject,

} = require("../controllers/projectSalesInvoiceController");

router.get("/project/:projectId", getSalesByProject);
// router.get("/:id", getPurchaseOrder);
// router.post("/", createPurchaseOrder);
// router.put("/:id", updatePurchaseOrder);
// router.delete("/:id", deletePurchaseOrder);

module.exports = router;