const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const authMiddleware = require('../middleware/authMiddleware');

// Apply authentication middleware to all routes
router.use(authMiddleware);

// Settings routes
router.get('/', settingsController.getUserSettings);
router.get('/:type', settingsController.getSettingsByType);
router.put('/update', settingsController.updateSettings);
router.put('/update-multiple', settingsController.updateMultipleSettings);

// Avatar routes - UPDATED WITH COMPLETE FUNCTIONALITY
router.post('/avatar', settingsController.uploadMiddleware, settingsController.uploadAvatar);
router.get('/avatar', settingsController.getUserAvatar); // NEW: Get avatar
router.delete('/avatar', settingsController.deleteAvatar); // NEW: Delete avatar

// Security routes
router.post('/security/verify-password', settingsController.verifyCurrentPassword);
router.put('/security/password', settingsController.updatePassword);
router.put('/security/update', settingsController.updateSecuritySettings);
router.get('/security/settings', settingsController.getSecuritySettings);

// Email validation route
router.post('/check-email', settingsController.checkEmailUnique);
router.get('/user-profile', settingsController.getUserProfile);
router.put('/user-profile', settingsController.updateUserProfile);
router.post('/check-username', settingsController.checknameUnique);

module.exports = router;