const express = require("express");
const router = express.Router();
const db = require("../config/db");
const creditNoteController = require('../controllers/creditNotesController');

// Credit Note Routes
router.get('/', creditNoteController.getAllCreditNotes);
router.get('/next-number', creditNoteController.getNextCreditNoteNumber);
router.get('/:id', creditNoteController.getCreditNoteById);
router.post('/', creditNoteController.createCreditNote);
router.put('/:id', creditNoteController.updateCreditNote);
router.delete('/:id', creditNoteController.deleteCreditNote);
router.get('/:id/balance', creditNoteController.getCreditNoteBalance);
router.get('/stats/summary', creditNoteController.getCreditNoteStats);

module.exports = router;
