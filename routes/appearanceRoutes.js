const express = require('express');
const router = express.Router();
const { getAppearance, updateAppearance } = require('../controllers/appearanceController');

router.get('/', getAppearance);
router.put('/', updateAppearance);

module.exports = router;
