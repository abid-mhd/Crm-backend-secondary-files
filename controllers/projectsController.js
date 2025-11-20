// controllers/projectsController.js
const db = require("../config/db");

// Get all projects with pagination and filtering
exports.getProjects = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '', filter = 'All' } = req.query;
    const offset = (page - 1) * limit;

    let baseQuery = `SELECT * FROM projects WHERE 1=1`;
    let countQuery = `SELECT COUNT(*) as total FROM projects WHERE 1=1`;
    
    const params = [];
    const countParams = [];

    // Search filter
    if (search && search.trim() !== '') {
      const searchCondition = ` AND (project_name LIKE ? OR project_no LIKE ? OR description LIKE ?)`;
      baseQuery += searchCondition;
      countQuery += searchCondition;
      
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam);
      countParams.push(searchParam, searchParam, searchParam);
    }

    // Type filter
    if (filter && filter !== 'All') {
      const filterCondition = ` AND project_type = ?`;
      baseQuery += filterCondition;
      countQuery += filterCondition;
      
      params.push(filter);
      countParams.push(filter);
    }

    // Add ordering and pagination to main query
    baseQuery += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    console.log('Main Query:', baseQuery);
    console.log('Main Params:', params);
    console.log('Count Query:', countQuery);
    console.log('Count Params:', countParams);

    // Execute queries
    const [rows] = await db.execute(baseQuery, params);
    const [countRows] = await db.execute(countQuery, countParams);

    const total = countRows[0].total;
    const totalPages = Math.ceil(total / limit);

    res.json({
      projects: rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalItems: total,
        itemsPerPage: parseInt(limit)
      }
    });
  } catch (err) {
    console.error("Error fetching projects:", err);
    console.error("SQL Error details:", err.sql, err.sqlMessage);
    res.status(500).json({ message: "Error fetching projects", error: err.message });
  }
};

// Alternative simpler version (keeping for backward compatibility)
exports.getProjectsSimple = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '', filter = 'All' } = req.query;
    const offset = (page - 1) * limit;

    let query = `SELECT * FROM projects WHERE 1=1`;
    let countQuery = `SELECT COUNT(*) as total FROM projects WHERE 1=1`;
    
    const params = [];
    const countParams = [];

    // Search filter
    if (search && search.trim() !== '') {
      const searchCondition = ` AND (project_name LIKE ? OR project_no LIKE ? OR description LIKE ?)`;
      query += searchCondition;
      countQuery += searchCondition;
      
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam);
      countParams.push(searchParam, searchParam, searchParam);
    }

    // Type filter
    if (filter && filter !== 'All') {
      const filterCondition = ` AND project_type = ?`;
      query += filterCondition;
      countQuery += filterCondition;
      
      params.push(filter);
      countParams.push(filter);
    }

    // Add pagination - embed directly in query since LIMIT/OFFSET don't work well with placeholders
    const limitNum = parseInt(limit);
    const offsetNum = parseInt(offset);
    query += ` ORDER BY created_at DESC LIMIT ${limitNum} OFFSET ${offsetNum}`;

    console.log('Final Query:', query);
    console.log('Final Params:', params);
    console.log('Count Query:', countQuery);
    console.log('Count Params:', countParams);

    const [rows] = params.length > 0 ? await db.execute(query, params) : await db.query(query);
    const [countRows] = await db.execute(countQuery, countParams);

    const total = countRows[0].total;
    const totalPages = Math.ceil(total / limit);

    res.json({
      projects: rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalItems: total,
        itemsPerPage: parseInt(limit)
      }
    });
  } catch (err) {
    console.error("Error in getProjectsSimple:", err);
    res.status(500).json({ message: "Error fetching projects", error: err.message });
  }
};

// Get single project by ID
exports.getProject = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.execute("SELECT * FROM projects WHERE id = ?", [id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ message: "Project not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching project:", err);
    res.status(500).json({ message: "Error fetching project", error: err.message });
  }
};

// Check if project number exists
exports.checkProjectNo = async (req, res) => {
  try {
    const { projectNo } = req.query;
    
    if (!projectNo) {
      return res.status(400).json({ error: "Project number is required" });
    }

    const [rows] = await db.execute("SELECT id FROM projects WHERE project_no = ?", [projectNo]);

    if (rows.length > 0) {
      return res.json({ exists: true });
    } else {
      return res.json({ exists: false });
    }
  } catch (error) {
    console.error("Error checking project number:", error);
    res.status(500).json({ error: "Server error" });
  }
};

// Helper functions
const safeValue = (val, defaultValue = null) => val === undefined ? defaultValue : val;
const safeNumber = (val, defaultValue = 0) => {
  if (val === '' || val === null || val === undefined) return defaultValue;
  const num = Number(val);
  return isNaN(num) ? defaultValue : num;
};

const safeString = (val, defaultValue = null) => {
  if (val === '' || val === null || val === undefined) return defaultValue;
  return String(val);
};

// Create project
exports.createProject = async (req, res) => {
  try {
    const {
      project_no,
      project_name,
      description,
      status = 'Active',
      project_type,
      logo_url,
      icon_color = 'rose',
      icon_type = 'Calendar',
      meta_data
    } = req.body;

    console.log('Received data:', req.body);

    // Validate required fields
    if (!project_no || !project_name || !project_type) {
      return res.status(400).json({ message: "Project number, name, and type are required" });
    }

    // Check if project number already exists
    const [existing] = await db.execute("SELECT id FROM projects WHERE project_no = ?", [project_no]);
    if (existing.length > 0) {
      return res.status(400).json({ message: "Project number already exists" });
    }

    const [result] = await db.execute(
      `INSERT INTO projects 
      (project_no, project_name, description, status, project_type, logo_url, 
       icon_color, icon_type, meta_data, created_at, updated_at) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        safeString(project_no),
        safeString(project_name),
        safeString(description),
        safeString(status),
        safeString(project_type),
        safeString(logo_url),
        safeString(icon_color),
        safeString(icon_type),
        meta_data ? JSON.stringify(meta_data) : null
      ]
    );

    res.status(201).json({ 
      message: "Project created successfully", 
      id: result.insertId,
      project: {
        id: result.insertId,
        project_no,
        project_name,
        description,
        status: safeString(status),
        project_type,
        logo_url: safeString(logo_url),
        icon_color: safeString(icon_color),
        icon_type: safeString(icon_type),
        meta_data: meta_data || null
      }
    });
  } catch (err) {
    console.error("Error creating project:", err);
    res.status(500).json({ message: "Error creating project", error: err.message });
  }
};

// Update project
exports.updateProject = async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch existing project
    const [rows] = await db.execute("SELECT * FROM projects WHERE id = ?", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Project not found" });
    }

    const {
      project_no,
      project_name,
      description,
      status,
      project_type,
      logo_url,
      icon_color,
      icon_type,
      meta_data
    } = req.body;

    // Validate required fields
    if (!project_no || !project_name || !project_type) {
      return res.status(400).json({ message: "Project number, name, and type are required" });
    }

    // Check if project number already exists (excluding current project)
    const [existing] = await db.execute(
      "SELECT id FROM projects WHERE project_no = ? AND id != ?", 
      [project_no, id]
    );
    if (existing.length > 0) {
      return res.status(400).json({ message: "Project number already exists" });
    }

    await db.execute(
      `UPDATE projects 
       SET project_no=?, project_name=?, description=?, status=?, project_type=?, 
           logo_url=?, icon_color=?, icon_type=?, meta_data=?, updated_at=NOW()
       WHERE id=?`,
      [
        safeString(project_no),
        safeString(project_name),
        safeString(description),
        safeString(status, 'Active'),
        safeString(project_type),
        safeString(logo_url),
        safeString(icon_color),
        safeString(icon_type),
        meta_data ? JSON.stringify(meta_data) : null,
        id
      ]
    );

    res.json({ message: "Project updated successfully" });
  } catch (err) {
    console.error("Error updating project:", err);
    res.status(500).json({ message: "Error updating project", error: err.message });
  }
};

// Delete project
exports.deleteProject = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if project exists
    const [projectRows] = await db.execute("SELECT * FROM projects WHERE id = ?", [id]);
    if (projectRows.length === 0) {
      return res.status(404).json({ message: "Project not found" });
    }

    await db.execute("DELETE FROM projects WHERE id = ?", [id]);

    res.json({ message: "Project deleted successfully" });
  } catch (err) {
    console.error("Error deleting project:", err);
    res.status(500).json({ message: "Error deleting project", error: err.message });
  }
};