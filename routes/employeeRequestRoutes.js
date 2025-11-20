const express = require('express');
const router = express.Router();
const employeeRequestController = require('../controllers/employeeRequestController');
const auth = require('../middleware/authMiddleware');
const multer = require('multer');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/requests/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || 
        file.mimetype === 'application/pdf' || 
        file.mimetype === 'application/msword' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      cb(null, true);
    } else {
      cb(new Error('Only images, PDF, and Word documents are allowed'), false);
    }
  }
});
// Employee routes
router.get('/overdue-records', auth, employeeRequestController.getMyOverdueRecords.bind(employeeRequestController));
router.post('/unmark-absent', auth, employeeRequestController.createUnmarkAbsentRequest.bind(employeeRequestController));
router.get('/my-requests', auth, employeeRequestController.getMyRequests.bind(employeeRequestController));
router.post('/create', auth, upload.single('supporting_document'), employeeRequestController.createNewRequest.bind(employeeRequestController));

// Admin/HR routes
router.get('/all-requests', auth, employeeRequestController.getAllRequests.bind(employeeRequestController));
router.get('/pending-requests', auth, employeeRequestController.getAllPendingRequests.bind(employeeRequestController));
router.put('/:requestId/status', auth, employeeRequestController.updateRequestStatus.bind(employeeRequestController));

// Test endpoint
router.post('/test-notification', auth, employeeRequestController.testNotification.bind(employeeRequestController));

module.exports = router;