// routes/ewayBillRoutes.js
const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const {
  generateEwayBill,
  uploadEwayBillPdf,
  getEwayBillsByInvoice,
  getEwayBill,
  getAllEwayBills,
  cancelEwayBill,
  serveEwayBillPdf,
  getEwayBillsByProject,
  getInvoicesForEwayBill,
  createManualEwayBill,
  getEwayBills  // Make sure this is imported correctly
} = require("../controllers/ewayBillController");

// Ensure uploads directory exists
const ensureUploadsDir = () => {
  const uploadsDir = path.join(__dirname, '../uploads/ewaybills');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  return uploadsDir;
};

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = ensureUploadsDir();
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'ewaybill-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit
  }
});

// Routes
router.post("/generate", generateEwayBill);
router.post("/upload-pdf", upload.single('pdf'), uploadEwayBillPdf);
router.get("/invoice/:invoice_id", getEwayBillsByInvoice);
router.get("/:project_id", getEwayBills); // Fixed this line
router.get('/invoices/:project_id', getInvoicesForEwayBill);
router.get("/project/:project_id", getEwayBillsByProject);
router.get("/:id", getEwayBill);
router.get("/", getAllEwayBills);
router.put("/:id/cancel", cancelEwayBill);
router.get("/pdf/:filename", serveEwayBillPdf);
router.post('/manual', createManualEwayBill);

module.exports = router;