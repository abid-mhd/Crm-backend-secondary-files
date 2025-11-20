// routes/projects.js
const router = require("express").Router();
const {
  getProjects,
  getProjectsSimple,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  checkProjectNo
} = require("../controllers/projectsController");

router.get("/", getProjectsSimple); // Use the simple version for now
router.get('/:id', getProject);
router.post("/", createProject);    
router.put("/:id", updateProject);  
router.delete("/:id", deleteProject); 
router.get("/check-project-no", checkProjectNo);

module.exports = router;