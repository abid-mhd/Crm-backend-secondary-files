const router = require("express").Router();
const {
  getPurchaseOrdersByProject,
  createPurchaseOrder,
  getPurchaseOrder,
  updatePurchaseOrder,
  deletePurchaseOrder
} = require("../controllers/projectPoController");

router.get("/project/:projectId", getPurchaseOrdersByProject);
// router.get("/:id", getPurchaseOrder);
// router.post("/", createPurchaseOrder);
// router.put("/:id", updatePurchaseOrder);
// router.delete("/:id", deletePurchaseOrder);

module.exports = router;