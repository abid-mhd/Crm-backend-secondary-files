const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');

// Add authMiddleware to protected routes
router.put('/password', authMiddleware, authController.updatePassword);

// Public routes (no auth required)
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);

// Your existing routes
router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/create-password', authController.createPassword);
router.get('/me', authMiddleware, authController.getCurrentUser);

module.exports = router;