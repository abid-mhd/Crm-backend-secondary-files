// templateRoutes.js
const db = require('../config/db');
const express = require('express');
const router = express.Router();

// Get template config for invoice
router.get('/invoice/:invoiceId', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    console.log('Fetching template config for invoice:', invoiceId);
    
    const [config] = await db.query(
      'SELECT * FROM invoice_template_configs WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1',
      [invoiceId]
    );
    
    console.log('Query result:', config);
    
    if (config && config.length > 0) {
      // Parse the JSON config from database
      const configData = typeof config[0].config === 'string' 
        ? JSON.parse(config[0].config) 
        : config[0].config;
      
      res.json({ 
        success: true, 
        config: configData,
        id: config[0].id 
      });
    } else {
      console.log('No config found for invoice:', invoiceId);
      res.status(404).json({ 
        success: false, 
        message: 'No template config found',
        config: null 
      });
    }
  } catch (error) {
    console.error('Error fetching invoice template config:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      config: null 
    });
  }
});

// Get project template config
router.get('/project/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    console.log('Fetching template config for project:', projectId);
    
    const [config] = await db.query(
      'SELECT * FROM project_template_configs WHERE project_id = ?',
      [projectId]
    );
    
    console.log('Query result:', config);
    
    if (config && config.length > 0) {
      // Parse the JSON config from database
      const configData = typeof config[0].config === 'string' 
        ? JSON.parse(config[0].config) 
        : config[0].config;
      
      res.json({ 
        success: true, 
        config: configData,
        id: config[0].id 
      });
    } else {
      console.log('No config found for project:', projectId);
      res.status(404).json({ 
        success: false, 
        message: 'No project template config found',
        config: null 
      });
    }
  } catch (error) {
    console.error('Error fetching project template config:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      config: null 
    });
  }
});

// Save template config
router.post('/', async (req, res) => {
  try {
    const { invoice_id, project_id, config, created_by } = req.body;
    
    console.log('Saving template config:', { invoice_id, project_id, created_by });
    
    // Validate config
    if (!config) {
      return res.status(400).json({ 
        success: false, 
        error: 'Config data is required' 
      });
    }
    
    // Stringify the config object for database storage
    const configString = JSON.stringify(config);
    
    // Check if config already exists for this invoice
    const [existing] = await db.query(
      'SELECT id FROM invoice_template_configs WHERE invoice_id = ?',
      [invoice_id]
    );
    
    let result;
    if (existing && existing.length > 0) {
      // Update existing
      result = await db.query(
        'UPDATE invoice_template_configs SET config = ?, project_id = ?, updated_at = NOW() WHERE invoice_id = ?',
        [configString, project_id, invoice_id]
      );
      console.log('Updated existing template config:', result);
    } else {
      // Insert new
      result = await db.query(
        'INSERT INTO invoice_template_configs (invoice_id, project_id, config, created_by) VALUES (?, ?, ?, ?)',
        [invoice_id, project_id, configString, created_by || 'system']
      );
      console.log('Inserted new template config:', result);
    }
    
    res.json({ 
      success: true, 
      message: 'Template config saved successfully',
      id: existing && existing.length > 0 ? existing[0].id : result.insertId 
    });
  } catch (error) {
    console.error('Error saving template config:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;