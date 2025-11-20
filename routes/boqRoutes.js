const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const {
  uploadBoqExcel,
  getBoqItems,
  getBoqSummary,
  addBoqItem,
  updateBoqItem,
  deleteBoqItem,
  getUploadHistory,
  exportBoqToExcel,
  manualBoqEntry,
  uploadBoqExcelSimple
} = require("../controllers/boqController");

// Ensure uploads directory exists
const ensureUploadsDir = () => {
  const uploadsDir = path.join(__dirname, '../uploads/boq');
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
    cb(null, 'boq-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || 
        file.mimetype === 'application/vnd.ms-excel' ||
        file.mimetype === 'application/octet-stream') {
      cb(null, true);
    } else {
      cb(new Error('Only Excel files are allowed'), false);
    }
  },
  limits: {
    fileSize: 20 * 1024 * 1024 // 20MB limit for larger BOQ files
  }
});

// Routes
router.post('/upload-excel', upload.single('excel'), uploadBoqExcelSimple);
router.post("/manual/:project_id", manualBoqEntry);
router.get("/project/:project_id", getBoqItems);
router.get("/summary/:project_id", getBoqSummary);
router.get("/uploads/:project_id", getUploadHistory);
router.get("/export/:project_id", exportBoqToExcel);
router.post("/", addBoqItem);
router.put("/:id", updateBoqItem);
router.delete("/:id", deleteBoqItem);

module.exports = router;