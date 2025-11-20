const express = require('express');
const router = express.Router();

// Import the controller properly
const announcementController = require('../controllers/announcementController');

// Define all routes
router.get('/', announcementController.getAnnouncements);
router.post('/', announcementController.createAnnouncement);
router.delete('/:id', announcementController.deleteAnnouncement);
router.get('/test', announcementController.testConnection);
router.get('/active', announcementController.getActiveAnnouncements);

router.get('/birthday/employees', announcementController.getEmployeesForBirthday);
router.post('/birthday', announcementController.sendBirthdayAnnouncement);

module.exports = router;