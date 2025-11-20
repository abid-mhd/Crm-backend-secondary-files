const router = require("express").Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const {
  uploadVendorPoPdf,
  getVendorPosByProject,
  getVendorPo,
  serveVendorPoPdf,
  deleteVendorPo
} = require("../controllers/vendorPoController");

// Ensure uploads directory exists
const ensureUploadsDir = () => {
  const uploadsDir = path.join(__dirname, '../uploads/vendor_po');
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
    cb(null, 'vendor_po-' + uniqueSuffix + path.extname(file.originalname));
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
router.post("/upload", upload.single('pdf'), uploadVendorPoPdf);
router.get("/project/:project_id", getVendorPosByProject);
router.get("/:id", getVendorPo);
router.get("/pdf/:filename", serveVendorPoPdf);
router.delete("/:id", deleteVendorPo);

module.exports = router;