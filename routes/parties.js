const router = require("express").Router();
const {
  getParties,
  createParty,
  updateParty,
  deleteParty,
  getParty,
  getPartyByClientId,
  checkEmail
} = require("../controllers/partiesController");

router.get("/", getParties);  
router.get('/:id', getParty);
router.get('/client/:clientId', getPartyByClientId);    
router.post("/", createParty);    
router.put("/:id", updateParty);  
router.delete("/:id", deleteParty); 
router.get("/check-email", checkEmail);


module.exports = router;
