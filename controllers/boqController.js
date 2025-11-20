const db = require("../config/db");
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

// Ensure uploads directory exists
const ensureUploadsDir = () => {
  const uploadsDir = path.join(__dirname, '../uploads/boq');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  return uploadsDir;
};

// Get database connection from pool
const getConnection = () => {
  return new Promise((resolve, reject) => {
    db.getConnection((err, connection) => {
      if (err) {
        reject(err);
      } else {
        resolve(connection);
      }
    });
  });
};

// Enhanced Excel parsing for your specific format
const parseBoqExcel = (filePath) => {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Get the entire worksheet data
    const data = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: false });
    
    console.log('Excel data rows:', data.length);
    
    // Process the data based on your specific Excel structure
    const boqItems = processJSWExcelData(data);
    
    return boqItems;
  } catch (error) {
    console.error('Error parsing Excel file:', error);
    throw new Error('Failed to parse Excel file: ' + error.message);
  }
};

// Custom parser for JSW Excel format
const processJSWExcelData = (data) => {
  const boqItems = [];
  let currentCategory = '';
  let currentSubCategory = '';
  let currentItem = null;
  let currentSpecification = '';
  
  // Find the start of actual data (skip headers)
  let startRow = 0;
  for (let i = 0; i < Math.min(20, data.length); i++) {
    const row = data[i];
    if (row && row.length > 0) {
      const firstCell = row[0]?.toString().trim();
      if (firstCell === 'S.No' || firstCell === '1' || firstCell === '(1)') {
        startRow = i;
        break;
      }
    }
  }

  for (let i = startRow; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length < 2) continue;

    // Clean the row data
    const cleanRow = row.map(cell => {
      if (cell === null || cell === undefined) return '';
      const str = cell.toString().trim();
      return str === '-' || str === 'null' ? '' : str;
    });

    const serialNo = cleanRow[0];
    const description = cleanRow[1] || '';
    const size = cleanRow[2] || '';
    const quantity = parseFloat(cleanRow[3]) || 0;
    const unit = cleanRow[4] || '';
    const supplyRate = parseFloat(cleanRow[5]) || 0;
    const erectionRate = parseFloat(cleanRow[6]) || 0;
    const supplyAmount = parseFloat(cleanRow[7]) || 0;
    const erectionAmount = parseFloat(cleanRow[8]) || 0;
    const totalAmount = parseFloat(cleanRow[9]) || 0;
    const note = cleanRow[10] || '';
    const receivedStatus = cleanRow[11] || '';

    // Handle categories and subcategories
    if (description) {
      // Main categories (Roman numerals I, II, III, etc.)
      if (serialNo.match(/^[IVXLCDM]+$/i) && description) {
        currentCategory = description;
        currentSubCategory = '';
        currentSpecification = '';
        continue;
      }
      
      // Sub-categories (1, 2, 3 with main descriptions)
      if (serialNo.match(/^\d+[a-z]?$/) && description && description.length > 10) {
        // Check if this is a main item description
        if (!description.match(/^[A-Z\s]+$/) && // Not all caps
            !description.match(/^Part-[A-Z]/) && // Not part headers
            description.length > 20) {
          
          // This is likely a main item
          if (currentItem && currentItem.item_description) {
            boqItems.push(currentItem);
          }
          
          currentItem = {
            serial_number: serialNo,
            item_description: description,
            size: size,
            quantity: quantity,
            unit: unit,
            supply_rate: supplyRate,
            erection_rate: erectionRate,
            supply_amount: supplyAmount,
            erection_amount: erectionAmount,
            total_amount: totalAmount,
            category: currentCategory,
            sub_category: currentSubCategory,
            specification: currentSpecification,
            meta_data: {
              note: note,
              received_status: receivedStatus,
              row_data: cleanRow
            }
          };
          
          currentSpecification = '';
          continue;
        }
      }
      
      // Sub-items (indented descriptions without serial numbers)
      if ((!serialNo || serialNo === '') && description && description.length > 5) {
        if (currentItem) {
          // This is a sub-item or specification for the current item
          if (description.match(/^[A-Z][a-z]/) && !description.match(/:/)) {
            // This might be a new specification line
            currentSpecification = description;
          } else {
            // Add to current item's specification or create sub-item
            if (currentItem.specification) {
              currentItem.specification += '\n' + description;
            } else {
              currentItem.specification = description;
            }
            
            // If this looks like a material item with size and quantity
            if (size && quantity > 0) {
              // Create a sub-item
              const subItem = {
                serial_number: currentItem.serial_number + '-sub',
                item_description: description,
                size: size,
                quantity: quantity,
                unit: unit,
                supply_rate: supplyRate,
                erection_rate: erectionRate,
                supply_amount: supplyAmount,
                erection_amount: erectionAmount,
                total_amount: totalAmount,
                category: currentCategory,
                sub_category: currentItem.item_description,
                specification: '',
                meta_data: {
                  parent_item: currentItem.item_description,
                  note: note,
                  received_status: receivedStatus,
                  row_data: cleanRow
                }
              };
              
              boqItems.push(subItem);
            }
          }
        }
      }
    }

    // Handle items with quantities (main data rows)
    if (serialNo && description && quantity > 0 && unit) {
      // This is a valid item row
      const boqItem = {
        serial_number: serialNo,
        item_description: description,
        size: size,
        quantity: quantity,
        unit: unit,
        supply_rate: supplyRate,
        erection_rate: erectionRate,
        supply_amount: supplyAmount,
        erection_amount: erectionAmount,
        total_amount: totalAmount,
        category: currentCategory,
        sub_category: currentSubCategory,
        specification: currentSpecification,
        meta_data: {
          note: note,
          received_status: receivedStatus,
          row_data: cleanRow
        }
      };

      // Calculate amounts if not provided
      if (!boqItem.supply_amount && boqItem.supply_rate && boqItem.quantity) {
        boqItem.supply_amount = parseFloat((boqItem.supply_rate * boqItem.quantity).toFixed(2));
      }
      
      if (!boqItem.erection_amount && boqItem.erection_rate && boqItem.quantity) {
        boqItem.erection_amount = parseFloat((boqItem.erection_rate * boqItem.quantity).toFixed(2));
      }
      
      if (!boqItem.total_amount) {
        boqItem.total_amount = parseFloat(((boqItem.supply_amount || 0) + (boqItem.erection_amount || 0)).toFixed(2));
      }

      boqItems.push(boqItem);
      console.log(`✓ Added item: ${description.substring(0, 50)}...`);
    }
  }

  // Don't forget to add the last item
  if (currentItem && currentItem.item_description) {
    boqItems.push(currentItem);
  }

  console.log(`Processed ${boqItems.length} BOQ items`);
  return boqItems;
};

// Alternative parser for more complex Excel structures
const parseComplexBoqExcel = (filePath) => {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Get cell references to understand structure
    const range = XLSX.utils.decode_range(worksheet['!ref']);
    const boqItems = [];
    
    let currentCategory = '';
    let currentItem = null;
    
    // Iterate through all rows
    for (let R = range.s.r; R <= range.e.r; R++) {
      const row = [];
      for (let C = range.s.c; C <= range.e.c; C++) {
        const cellAddress = { c: C, r: R };
        const cellRef = XLSX.utils.encode_cell(cellAddress);
        const cell = worksheet[cellRef];
        row.push(cell ? cell.v : '');
      }
      
      if (row.length < 2) continue;
      
      const serialNo = row[0]?.toString().trim() || '';
      const description = row[1]?.toString().trim() || '';
      
      // Skip empty rows and headers
      if (!description || description.match(/S\.No|Description|Size|Qty|Unit|Rate|Amount/i)) {
        continue;
      }
      
      // Handle categories (Roman numerals)
      if (serialNo.match(/^[IVXLCDM]+$/i) && description) {
        currentCategory = description;
        continue;
      }
      
      // Handle main items (numbered items)
      if (serialNo.match(/^\d+[a-z]?$/) && description && description.length > 10) {
        // Save previous item if exists
        if (currentItem) {
          boqItems.push(currentItem);
        }
        
        currentItem = {
          serial_number: serialNo,
          item_description: description,
          size: row[2] || '',
          quantity: parseFloat(row[3]) || 0,
          unit: row[4] || '',
          supply_rate: parseFloat(row[5]) || 0,
          erection_rate: parseFloat(row[6]) || 0,
          supply_amount: parseFloat(row[7]) || 0,
          erection_amount: parseFloat(row[8]) || 0,
          total_amount: parseFloat(row[9]) || 0,
          category: currentCategory,
          meta_data: {
            note: row[10] || '',
            received_status: row[11] || '',
            full_row: row
          }
        };
        
        // Calculate amounts if needed
        if (!currentItem.supply_amount && currentItem.supply_rate && currentItem.quantity) {
          currentItem.supply_amount = currentItem.supply_rate * currentItem.quantity;
        }
        if (!currentItem.erection_amount && currentItem.erection_rate && currentItem.quantity) {
          currentItem.erection_amount = currentItem.erection_rate * currentItem.quantity;
        }
        if (!currentItem.total_amount) {
          currentItem.total_amount = (currentItem.supply_amount || 0) + (currentItem.erection_amount || 0);
        }
        
        continue;
      }
      
      // Handle sub-items (no serial number but has description)
      if ((!serialNo || serialNo === '') && description && description.length > 5) {
        const size = row[2] || '';
        const quantity = parseFloat(row[3]) || 0;
        const unit = row[4] || '';
        
        if (quantity > 0 && unit) {
          // This is a sub-item with quantity
          const subItem = {
            serial_number: currentItem ? currentItem.serial_number + '-sub' : 'sub',
            item_description: description,
            size: size,
            quantity: quantity,
            unit: unit,
            supply_rate: parseFloat(row[5]) || 0,
            erection_rate: parseFloat(row[6]) || 0,
            supply_amount: parseFloat(row[7]) || 0,
            erection_amount: parseFloat(row[8]) || 0,
            total_amount: parseFloat(row[9]) || 0,
            category: currentCategory,
            sub_category: currentItem ? currentItem.item_description : '',
            meta_data: {
              note: row[10] || '',
              received_status: row[11] || '',
              full_row: row
            }
          };
          
          // Calculate amounts if needed
          if (!subItem.supply_amount && subItem.supply_rate && subItem.quantity) {
            subItem.supply_amount = subItem.supply_rate * subItem.quantity;
          }
          if (!subItem.erection_amount && subItem.erection_rate && subItem.quantity) {
            subItem.erection_amount = subItem.erection_rate * subItem.quantity;
          }
          if (!subItem.total_amount) {
            subItem.total_amount = (subItem.supply_amount || 0) + (subItem.erection_amount || 0);
          }
          
          boqItems.push(subItem);
        } else if (currentItem) {
          // This is a specification line
          if (currentItem.specification) {
            currentItem.specification += '\n' + description;
          } else {
            currentItem.specification = description;
          }
        }
      }
    }
    
    // Don't forget the last item
    if (currentItem) {
      boqItems.push(currentItem);
    }
    
    console.log(`✓ Parsed ${boqItems.length} items using complex parser`);
    return boqItems;
    
  } catch (error) {
    console.error('Error in complex parser:', error);
    throw error;
  }
};

// Upload BOQ Excel - Fixed transaction handling
exports.uploadBoqExcel = async (req, res) => {
  let connection;
  try {
    const { project_id } = req.body;

    if (!req.file) {
      return res.status(400).json({ message: "Excel file is required" });
    }

    if (!project_id) {
      return res.status(400).json({ message: "Project ID is required" });
    }

    const uploadsDir = ensureUploadsDir();
    const excelFilePath = path.join(uploadsDir, req.file.filename);

    let parsedBoqData = [];
    let errorLog = [];

    try {
      console.log('Attempting to parse Excel file...');
      
      // Try the complex parser first
      parsedBoqData = parseComplexBoqExcel(excelFilePath);
      
      // If complex parser doesn't find items, try the original parser
      if (parsedBoqData.length === 0) {
        console.log('Complex parser found no items, trying original parser...');
        parsedBoqData = parseBoqExcel(excelFilePath);
      }
      
      if (parsedBoqData.length === 0) {
        throw new Error('No valid BOQ items found in the Excel file. Please check the format.');
      }
      
      console.log(`✓ Successfully parsed ${parsedBoqData.length} BOQ items`);
      
    } catch (parseError) {
      console.error('Excel parsing failed:', parseError.message);
      errorLog.push(`Parsing error: ${parseError.message}`);
      
      // Return parsing error with option for manual entry
      fs.unlinkSync(excelFilePath);
      return res.status(400).json({ 
        message: "Excel parsing failed. Please check the file format.",
        error: parseError.message,
        requires_manual_review: true
      });
    }

    // Get connection and start transaction
    connection = await getConnection();
    
    // Use regular query for transaction commands
    await new Promise((resolve, reject) => {
      connection.query('START TRANSACTION', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    try {
      let successCount = 0;
      let failedCount = 0;
      let totalAmount = 0;

      // Insert BOQ items
      for (const item of parsedBoqData) {
        try {
          const insertQuery = `
            INSERT INTO boq_items (
              project_id, serial_number, item_description, size, scope,
              quantity, unit, supply_rate, erection_rate, supply_amount,
              erection_amount, total_amount, category, sub_category, location,
              specification, meta_data, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          `;
          
          const insertParams = [
            parseInt(project_id),
            item.serial_number || '',
            item.item_description || '',
            item.size || '',
            item.scope || '',
            parseFloat(item.quantity) || 0,
            item.unit || '',
            parseFloat(item.supply_rate) || 0,
            parseFloat(item.erection_rate) || 0,
            parseFloat(item.supply_amount) || 0,
            parseFloat(item.erection_amount) || 0,
            parseFloat(item.total_amount) || 0,
            item.category || '',
            item.sub_category || '',
            item.location || '',
            item.specification || '',
            JSON.stringify(item.meta_data || { 
              source: 'excel_upload', 
              parsed_automatically: true,
              upload_timestamp: new Date().toISOString()
            })
          ];

          await new Promise((resolve, reject) => {
            connection.query(insertQuery, insertParams, (err, result) => {
              if (err) reject(err);
              else {
                successCount++;
                totalAmount += parseFloat(item.total_amount || 0);
                resolve(result);
              }
            });
          });

        } catch (itemError) {
          failedCount++;
          errorLog.push(`Failed to insert item: ${item.item_description} - ${itemError.message}`);
          console.error('Item insertion error:', itemError);
        }
      }

      // Record upload history
      const uploadQuery = `
        INSERT INTO boq_uploads (
          project_id, file_name, uploaded_by, total_items,
          total_amount, status, error_log, upload_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
      `;
      
      const uploadParams = [
        parseInt(project_id),
        req.file.originalname,
        req.user?.id || 1,
        successCount,
        totalAmount,
        failedCount === 0 ? 'success' : (successCount > 0 ? 'partial' : 'failed'),
        errorLog.length > 0 ? JSON.stringify(errorLog) : null
      ];

      await new Promise((resolve, reject) => {
        connection.query(uploadQuery, uploadParams, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });

      // Commit transaction
      await new Promise((resolve, reject) => {
        connection.query('COMMIT', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      res.json({
        message: `BOQ upload completed: ${successCount} items imported, ${failedCount} failed`,
        success_count: successCount,
        failed_count: failedCount,
        total_amount: totalAmount,
        errors: errorLog.length > 0 ? errorLog.slice(0, 5) : null,
        parsed_data: parsedBoqData.slice(0, 10) // Return more sample data
      });

    } catch (dbError) {
      // Rollback transaction on error
      if (connection) {
        await new Promise((resolve, reject) => {
          connection.query('ROLLBACK', (err) => {
            if (err) console.error('Rollback error:', err);
            resolve();
          });
        });
      }
      throw dbError;
    }

  } catch (err) {
    console.error("Error uploading BOQ Excel:", err);
    
    // Clean up file
    if (req.file) {
      try {
        const uploadsDir = ensureUploadsDir();
        const filePath = path.join(uploadsDir, req.file.filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (cleanupError) {
        console.error("Error cleaning up file:", cleanupError);
      }
    }
    
    res.status(500).json({ 
      message: "Error uploading BOQ Excel", 
      error: err.message 
    });
  } finally {
    // Release connection back to pool
    if (connection) {
      connection.release();
    }
  }
};

// Alternative version using async/await with connection pool (simpler approach)
exports.uploadBoqExcelSimple = async (req, res) => {
  try {
    const { project_id } = req.body;

    if (!req.file) {
      return res.status(400).json({ message: "Excel file is required" });
    }

    if (!project_id) {
      return res.status(400).json({ message: "Project ID is required" });
    }

    const uploadsDir = ensureUploadsDir();
    const excelFilePath = path.join(uploadsDir, req.file.filename);

    let parsedBoqData = [];
    let errorLog = [];

    try {
      console.log('Attempting to parse Excel file...');
      
      // Try the complex parser first
      parsedBoqData = parseComplexBoqExcel(excelFilePath);
      
      // If complex parser doesn't find items, try the original parser
      if (parsedBoqData.length === 0) {
        console.log('Complex parser found no items, trying original parser...');
        parsedBoqData = parseBoqExcel(excelFilePath);
      }
      
      if (parsedBoqData.length === 0) {
        throw new Error('No valid BOQ items found in the Excel file. Please check the format.');
      }
      
      console.log(`✓ Successfully parsed ${parsedBoqData.length} BOQ items`);
      
    } catch (parseError) {
      console.error('Excel parsing failed:', parseError.message);
      errorLog.push(`Parsing error: ${parseError.message}`);
      
      // Return parsing error with option for manual entry
      fs.unlinkSync(excelFilePath);
      return res.status(400).json({ 
        message: "Excel parsing failed. Please check the file format.",
        error: parseError.message,
        requires_manual_review: true
      });
    }

    let successCount = 0;
    let failedCount = 0;
    let totalAmount = 0;

    // Insert BOQ items without transaction (simpler approach)
    for (const item of parsedBoqData) {
      try {
        const [result] = await db.execute(`
          INSERT INTO boq_items (
            project_id, serial_number, item_description, size, scope,
            quantity, unit, supply_rate, erection_rate, supply_amount,
            erection_amount, total_amount, category, sub_category, location,
            specification, meta_data, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        `, [
          parseInt(project_id),
          item.serial_number || '',
          item.item_description || '',
          item.size || '',
          item.scope || '',
          parseFloat(item.quantity) || 0,
          item.unit || '',
          parseFloat(item.supply_rate) || 0,
          parseFloat(item.erection_rate) || 0,
          parseFloat(item.supply_amount) || 0,
          parseFloat(item.erection_amount) || 0,
          parseFloat(item.total_amount) || 0,
          item.category || '',
          item.sub_category || '',
          item.location || '',
          item.specification || '',
          JSON.stringify(item.meta_data || { 
            source: 'excel_upload', 
            parsed_automatically: true,
            upload_timestamp: new Date().toISOString()
          })
        ]);

        successCount++;
        totalAmount += parseFloat(item.total_amount || 0);
      } catch (itemError) {
        failedCount++;
        errorLog.push(`Failed to insert item: ${item.item_description} - ${itemError.message}`);
        console.error('Item insertion error:', itemError);
      }
    }

    // Record upload history
    const [uploadResult] = await db.execute(`
      INSERT INTO boq_uploads (
        project_id, file_name, uploaded_by, total_items,
        total_amount, status, error_log, upload_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
    `, [
      parseInt(project_id),
      req.file.originalname,
      req.user?.id || 1,
      successCount,
      totalAmount,
      failedCount === 0 ? 'success' : (successCount > 0 ? 'partial' : 'failed'),
      errorLog.length > 0 ? JSON.stringify(errorLog) : null
    ]);

    res.json({
      message: `BOQ upload completed: ${successCount} items imported, ${failedCount} failed`,
      success_count: successCount,
      failed_count: failedCount,
      total_amount: totalAmount,
      errors: errorLog.length > 0 ? errorLog.slice(0, 5) : null,
      parsed_data: parsedBoqData.slice(0, 10)
    });

  } catch (err) {
    console.error("Error uploading BOQ Excel:", err);
    
    // Clean up file
    if (req.file) {
      try {
        const uploadsDir = ensureUploadsDir();
        const filePath = path.join(uploadsDir, req.file.filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (cleanupError) {
        console.error("Error cleaning up file:", cleanupError);
      }
    }
    
    res.status(500).json({ 
      message: "Error uploading BOQ Excel", 
      error: err.message 
    });
  }
};

// Fixed Get BOQ items for project - SIMPLIFIED VERSION
exports.getBoqItems = async (req, res) => {
  try {
    const { project_id } = req.params;
    const { category, search } = req.query;

    // Build query safely
    let query = `SELECT * FROM boq_items WHERE project_id = ?`;
    const queryParams = [parseInt(project_id)];

    // Add filters if provided
    if (category && category !== '' && category !== 'undefined') {
      query += ` AND category LIKE ?`;
      queryParams.push(`%${category}%`);
    }

    if (search && search !== '' && search !== 'undefined') {
      query += ` AND (item_description LIKE ? OR serial_number LIKE ? OR location LIKE ?)`;
      const searchParam = `%${search}%`;
      queryParams.push(searchParam, searchParam, searchParam);
    }

    // Add ordering
    query += ` ORDER BY category, sub_category, serial_number`;

    console.log('Final Query:', query);
    console.log('Query Params:', queryParams);

    // Execute query
    const [rows] = await db.execute(query, queryParams);

    res.json({
      boq_items: rows,
      total: rows.length
    });

  } catch (err) {
    console.error("Error fetching BOQ items:", err);
    res.status(500).json({ 
      message: "Error fetching BOQ items", 
      error: err.message,
      sql: err.sql,
      sqlMessage: err.sqlMessage
    });
  }
};

// Get BOQ summary
exports.getBoqSummary = async (req, res) => {
  try {
    const { project_id } = req.params;

    const [summaryRows] = await db.execute(`
      SELECT 
        COUNT(*) as total_items,
        COALESCE(SUM(quantity), 0) as total_quantity,
        COALESCE(SUM(total_amount), 0) as total_amount,
        COUNT(DISTINCT category) as category_count,
        COUNT(DISTINCT unit) as unit_types
      FROM boq_items 
      WHERE project_id = ?
    `, [parseInt(project_id)]);

    const [categorySummary] = await db.execute(`
      SELECT 
        category,
        COUNT(*) as item_count,
        COALESCE(SUM(quantity), 0) as total_quantity,
        COALESCE(SUM(total_amount), 0) as category_amount
      FROM boq_items 
      WHERE project_id = ?
      GROUP BY category
      ORDER BY category_amount DESC
    `, [parseInt(project_id)]);

    res.json({
      summary: summaryRows[0] || { total_items: 0, total_quantity: 0, total_amount: 0, category_count: 0, unit_types: 0 },
      categories: categorySummary || []
    });

  } catch (err) {
    console.error("Error fetching BOQ summary:", err);
    res.status(500).json({ message: "Error fetching BOQ summary", error: err.message });
  }
};

// Add single BOQ item
exports.addBoqItem = async (req, res) => {
  try {
    const {
      project_id, serial_number, item_description, size, scope,
      quantity, unit, supply_rate, erection_rate, category,
      sub_category, location, specification
    } = req.body;

    // Validate required fields
    if (!item_description || !quantity || !unit) {
      return res.status(400).json({ 
        message: "Item description, quantity, and unit are required" 
      });
    }

    // Calculate amounts
    const supply_amount = (parseFloat(supply_rate) || 0) * (parseFloat(quantity) || 0);
    const erection_amount = (parseFloat(erection_rate) || 0) * (parseFloat(quantity) || 0);
    const total_amount = supply_amount + erection_amount;

    const [result] = await db.execute(`
      INSERT INTO boq_items (
        project_id, serial_number, item_description, size, scope,
        quantity, unit, supply_rate, erection_rate, supply_amount,
        erection_amount, total_amount, category, sub_category, location,
        specification, meta_data, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `, [
      parseInt(project_id),
      serial_number || '',
      item_description,
      size || '',
      scope || '',
      parseFloat(quantity),
      unit,
      parseFloat(supply_rate) || 0,
      parseFloat(erection_rate) || 0,
      supply_amount,
      erection_amount,
      total_amount,
      category || '',
      sub_category || '',
      location || '',
      specification || '',
      JSON.stringify({ source: 'manual_entry' })
    ]);

    const [newItem] = await db.execute('SELECT * FROM boq_items WHERE id = ?', [result.insertId]);

    res.status(201).json({
      message: "BOQ item added successfully",
      boq_item: newItem[0]
    });

  } catch (err) {
    console.error("Error adding BOQ item:", err);
    res.status(500).json({ message: "Error adding BOQ item", error: err.message });
  }
};

// Update BOQ item
exports.updateBoqItem = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    // Recalculate amounts if rates or quantity changed
    if (updateData.supply_rate !== undefined || updateData.quantity !== undefined || 
        updateData.erection_rate !== undefined) {
      
      const [currentItem] = await db.execute('SELECT * FROM boq_items WHERE id = ?', [parseInt(id)]);
      if (currentItem.length > 0) {
        const item = currentItem[0];
        const supplyRate = updateData.supply_rate !== undefined ? parseFloat(updateData.supply_rate) : item.supply_rate;
        const erectionRate = updateData.erection_rate !== undefined ? parseFloat(updateData.erection_rate) : item.erection_rate;
        const quantity = updateData.quantity !== undefined ? parseFloat(updateData.quantity) : item.quantity;
        
        updateData.supply_amount = parseFloat((supplyRate * quantity).toFixed(2));
        updateData.erection_amount = parseFloat((erectionRate * quantity).toFixed(2));
        updateData.total_amount = parseFloat((updateData.supply_amount + updateData.erection_amount).toFixed(2));
      }
    }

    const setClause = Object.keys(updateData)
      .map(key => `${key} = ?`)
      .join(', ');
    
    const values = [...Object.values(updateData), parseInt(id)];

    const [result] = await db.execute(
      `UPDATE boq_items SET ${setClause}, updated_at = NOW() WHERE id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "BOQ item not found" });
    }

    const [updatedItem] = await db.execute('SELECT * FROM boq_items WHERE id = ?', [parseInt(id)]);

    res.json({
      message: "BOQ item updated successfully",
      boq_item: updatedItem[0]
    });

  } catch (err) {
    console.error("Error updating BOQ item:", err);
    res.status(500).json({ message: "Error updating BOQ item", error: err.message });
  }
};

// Delete BOQ item
exports.deleteBoqItem = async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await db.execute('DELETE FROM boq_items WHERE id = ?', [parseInt(id)]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "BOQ item not found" });
    }

    res.json({ message: "BOQ item deleted successfully" });

  } catch (err) {
    console.error("Error deleting BOQ item:", err);
    res.status(500).json({ message: "Error deleting BOQ item", error: err.message });
  }
};

// Get upload history
exports.getUploadHistory = async (req, res) => {
  try {
    const { project_id } = req.params;

    const [rows] = await db.execute(`
      SELECT bu.*, u.name as uploaded_by_name
      FROM boq_uploads bu
      LEFT JOIN users u ON bu.uploaded_by = u.id
      WHERE bu.project_id = ?
      ORDER BY bu.upload_date DESC
    `, [parseInt(project_id)]);

    res.json(rows || []);

  } catch (err) {
    console.error("Error fetching upload history:", err);
    res.status(500).json({ message: "Error fetching upload history", error: err.message });
  }
};

// Export BOQ to Excel
exports.exportBoqToExcel = async (req, res) => {
  try {
    const { project_id } = req.params;

    const [boqItems] = await db.execute(`
      SELECT * FROM boq_items 
      WHERE project_id = ?
      ORDER BY 
        CASE 
          WHEN category = 'AIR HANDLING UNITS' THEN 1
          WHEN category = 'PIPES AND VALVES' THEN 2
          WHEN category LIKE '%CHILLED WATER%' THEN 3
          WHEN category LIKE '%VENTILATION%' THEN 4
          ELSE 5
        END,
        category, sub_category, 
        CAST(serial_number AS UNSIGNED), serial_number
    `, [parseInt(project_id)]);

    if (boqItems.length === 0) {
      return res.status(404).json({ message: "No BOQ items found for this project" });
    }

    // Create workbook
    const workbook = XLSX.utils.book_new();
    
    // Prepare data for Excel
    const excelData = [
      ['S.No', 'Description', 'Size', 'Scope', 'Qty', 'Unit', 'Supply Rate (₹)', 'Erection Rate (₹)', 'Supply Amount (₹)', 'Erection Amount (₹)', 'Total Amount (₹)', 'Category', 'Sub Category', 'Location', 'Specification']
    ];

    boqItems.forEach(item => {
      excelData.push([
        item.serial_number,
        item.item_description,
        item.size,
        item.scope,
        item.quantity,
        item.unit,
        item.supply_rate,
        item.erection_rate,
        item.supply_amount,
        item.erection_amount,
        item.total_amount,
        item.category,
        item.sub_category,
        item.location,
        item.specification
      ]);
    });

    const worksheet = XLSX.utils.aoa_to_sheet(excelData);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'BOQ');

    // Generate buffer
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=boq-project-${project_id}-${new Date().toISOString().split('T')[0]}.xlsx`);
    
    res.send(buffer);

  } catch (err) {
    console.error("Error exporting BOQ to Excel:", err);
    res.status(500).json({ message: "Error exporting BOQ to Excel", error: err.message });
  }
};

// Manual BOQ entry for failed parsing
exports.manualBoqEntry = async (req, res) => {
  try {
    const { project_id } = req.params;
    const { boq_items } = req.body;

    if (!boq_items || !Array.isArray(boq_items)) {
      return res.status(400).json({ message: "BOQ items array is required" });
    }

    await db.execute('START TRANSACTION');

    try {
      let successCount = 0;
      let failedCount = 0;
      const errors = [];

      for (const item of boq_items) {
        try {
          const supply_amount = (parseFloat(item.supply_rate) || 0) * (parseFloat(item.quantity) || 0);
          const erection_amount = (parseFloat(item.erection_rate) || 0) * (parseFloat(item.quantity) || 0);
          const total_amount = supply_amount + erection_amount;

          await db.execute(`
            INSERT INTO boq_items (
              project_id, serial_number, item_description, size, scope,
              quantity, unit, supply_rate, erection_rate, supply_amount,
              erection_amount, total_amount, category, sub_category, location,
              specification, meta_data, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          `, [
            parseInt(project_id),
            item.serial_number || '',
            item.item_description,
            item.size || '',
            item.scope || '',
            parseFloat(item.quantity) || 0,
            item.unit || '',
            parseFloat(item.supply_rate) || 0,
            parseFloat(item.erection_rate) || 0,
            supply_amount,
            erection_amount,
            total_amount,
            item.category || '',
            item.sub_category || '',
            item.location || '',
            item.specification || '',
            JSON.stringify({ source: 'manual_entry_bulk' })
          ]);

          successCount++;
        } catch (error) {
          failedCount++;
          errors.push(`Failed to add item: ${item.item_description} - ${error.message}`);
        }
      }

      await db.execute('COMMIT');

      res.json({
        message: `Manual BOQ entry completed: ${successCount} items added, ${failedCount} failed`,
        success_count: successCount,
        failed_count: failedCount,
        errors: errors.length > 0 ? errors : null
      });

    } catch (error) {
      await db.execute('ROLLBACK');
      throw error;
    }

  } catch (err) {
    console.error("Error in manual BOQ entry:", err);
    res.status(500).json({ message: "Error in manual BOQ entry", error: err.message });
  }
};