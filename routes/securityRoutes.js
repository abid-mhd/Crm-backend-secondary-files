const express = require('express');
const router = express.Router();
const { updatePassword } = require('../controllers/securityController');

router.put('/password', updatePassword);

module.exports = router;
