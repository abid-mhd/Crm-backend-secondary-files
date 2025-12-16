const express = require('express');
const router = express.Router();
const purchaseOrderController = require('../controllers/purchaseOrderController');

// Get the upload middleware from controller
const upload = purchaseOrderController.upload;

const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware);

// Purchase Order routes
router.get('/', purchaseOrderController.list);
router.get('/:id', purchaseOrderController.get);
router.post('/', purchaseOrderController.create);
router.put('/:id', purchaseOrderController.update);
router.delete('/:id', purchaseOrderController.delete);
router.patch('/:id/status', purchaseOrderController.updateStatus);

// Import routes - FIXED: Use upload.fields for multiple files
router.post('/import', upload.fields([
  { name: 'file', maxCount: 1 },  // Excel file
  { name: 'pdf_0', maxCount: 1 }, // PDF for row 0
  { name: 'pdf_1', maxCount: 1 }, // PDF for row 1
  { name: 'pdf_2', maxCount: 1 }, // PDF for row 2
  { name: 'pdf_3', maxCount: 1 }, // PDF for row 3
  { name: 'pdf_4', maxCount: 1 }, // PDF for row 4
  { name: 'pdf_5', maxCount: 1 }, // PDF for row 5
  { name: 'pdf_6', maxCount: 1 }, // PDF for row 6
  { name: 'pdf_7', maxCount: 1 }, // PDF for row 7
  { name: 'pdf_8', maxCount: 1 }, // PDF for row 8
  { name: 'pdf_9', maxCount: 1 }  // PDF for row 9
]), purchaseOrderController.importPurchaseOrders);

// PDF routes
router.post('/upload-pdf', upload.single('pdf'), purchaseOrderController.uploadPOPDF);
router.get('/:id/pdf', purchaseOrderController.getPOPDF);
router.get('/download/template', purchaseOrderController.downloadTemplate);
router.post('/associate-pdf', purchaseOrderController.associatePDFWithOrder);

router.get('/next-number/available', purchaseOrderController.getNextPurchaseOrderNumber);
router.get('/check-number/available', purchaseOrderController.checkPurchaseOrderNumber);

// History routes
router.get('/:id/history', purchaseOrderController.getHistory);

module.exports = router;