const router = require('express').Router();
const ctrl = require('../controllers/invoicesController');
const authMiddleware = require('../middleware/authMiddleware');

router.use(authMiddleware);

router.get('/', ctrl.list);
router.post('/', ctrl.create); // POST /api/invoices
router.get('/:id', ctrl.get);
router.put('/:id', ctrl.update);
router.delete('/:id', ctrl.delete);

router.get('/:id/balance', ctrl.balance);

module.exports = router;
