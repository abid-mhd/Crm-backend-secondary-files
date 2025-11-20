const db = require("../config/db");
const path = require("path");
const fs = require("fs");
const pdfParse = require('pdf-parse');

// Ensure uploads directory exists
const ensureUploadsDir = () => {
  const uploadsDir = path.join(__dirname, '../uploads/vendor_po');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  return uploadsDir;
};

// Enhanced PDF text extraction using pdf-parse
const extractTextFromPdf = async (filePath) => {
  try {
    console.log('Extracting text from PDF...');
    
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    
    console.log(`✓ Extracted ${data.text.length} characters from PDF`);
    console.log(`✓ PDF has ${data.numpages} pages`);
    
    return data.text;
  } catch (error) {
    console.error('Error extracting text from PDF:', error);
    throw new Error(`PDF text extraction failed: ${error.message}`);
  }
};

// Enhanced PDF parsing specifically for your PDF format
const parseVendorPoPdf = async (filePath) => {
  try {
    console.log('Starting PDF parsing...');
    
    // Extract text from PDF
    const text = await extractTextFromPdf(filePath);
    
    if (!text || text.trim().length < 10) {
      throw new Error('No text content found in PDF.');
    }
    
    console.log(`✓ Successfully extracted ${text.length} characters`);
    
    // Parse the extracted text
    const vendorPoData = parseVendorPoText(text);
    
    return vendorPoData;
  } catch (error) {
    console.error('PDF parsing error:', error);
    throw error;
  }
};

// Enhanced text parsing specifically for your PDF format
const parseVendorPoText = (text) => {
  const vendorPoData = {
    items: [],
    meta_data: {
      extraction_method: 'pdf-parse',
      parsed_text_length: text.length,
      parsing_success: true
    }
  };
  
  // Clean and normalize text
  const cleanText = text.replace(/\s+/g, ' ').trim();
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);

  console.log('=== TEXT PROCESSING ===');
  console.log('Total lines:', lines.length);

  // Extract Vendor Name
  const vendorNameMatch = text.match(/(M\.GNANASEKARAN|M\.\s*GNANASEKARAN)/i);
  if (vendorNameMatch) {
    vendorPoData.vendor_name = vendorNameMatch[1] || vendorNameMatch[0];
  }

  // Extract GST Number
  const gstMatch = text.match(/GST\s*No\s*:?\s*([A-Z0-9]{15})/i);
  if (gstMatch) {
    vendorPoData.vendor_gstin = gstMatch[1];
  }

  // Extract PO Number
  const poMatch = text.match(/(ICEBERGS.*Salem|ICEBERGS)/i);
  if (poMatch) {
    vendorPoData.po_number = poMatch[1] || poMatch[0];
  }

  // Extract Date
  const dateMatch = text.match(/Date\s*:?\s*(\d{2}\.\d{2}\.\d{4})/i);
  if (dateMatch) {
    vendorPoData.po_date = parseDate(dateMatch[1]);
  }

  // Extract Site Location
  const siteMatch = text.match(/Site\s*:?\s*([^\n]+)/i);
  if (siteMatch) {
    vendorPoData.site_location = siteMatch[1].trim();
  }

  // Extract items from the table
  vendorPoData.items = extractItemsFromText(text);
  
  // Calculate total amount
  vendorPoData.total_amount = vendorPoData.items.reduce((sum, item) => {
    return sum + (parseFloat(item.total) || 0);
  }, 0);
  
  // Work description from items
  if (vendorPoData.items.length > 0) {
    vendorPoData.work_description = vendorPoData.items.map(item => item.description).join(', ');
  }

  // Update metadata
  vendorPoData.meta_data.item_count = vendorPoData.items.length;
  vendorPoData.meta_data.parsing_method = 'enhanced';

  console.log('Parsed Vendor PO:', {
    vendor_name: vendorPoData.vendor_name,
    vendor_gstin: vendorPoData.vendor_gstin,
    po_number: vendorPoData.po_number,
    items_count: vendorPoData.items.length
  });

  return vendorPoData;
};

// Extract items specifically from your PDF table format
const extractItemsFromText = (text) => {
  const items = [];
  
  console.log('Extracting items from text...');
  
  // Split text into lines for processing
  const lines = text.split('\n').map(line => line.trim());
  
  let inTableSection = false;
  let tableLines = [];
  
  // Find the table section
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Look for table header
    if (line.match(/S1\.No|Description|Qty|Rate/i)) {
      inTableSection = true;
      continue;
    }
    
    if (inTableSection) {
      // Stop when we hit notes or end of table
      if (line.match(/Note:|Extra:|GST|Out-station/i)) {
        break;
      }
      
      // Skip empty lines
      if (line.length === 0) continue;
      
      // Add potential item lines
      tableLines.push(line);
    }
  }
  
  console.log('Table lines found:', tableLines);
  
  // Process table lines to extract items
  for (let i = 0; i < tableLines.length; i++) {
    const line = tableLines[i];
    
    // Skip header lines
    if (line.match(/S1\.No|Description|Qty|Rate/i)) continue;
    
    // Try to parse item line with multiple methods
    const item = parseItemLine(line);
    if (item) {
      items.push(item);
    }
  }
  
  return items;
};

// Enhanced item line parsing for your specific format
const parseItemLine = (line) => {
  try {
    // Remove leading numbers and dots (like "1.", "2.", etc.)
    let cleanLine = line.replace(/^\d+\.\s*/, '').trim();
    
    // Try to split by multiple spaces or common separators
    const parts = cleanLine.split(/\s{2,}/).filter(part => part.trim().length > 0);
    
    if (parts.length >= 3) {
      const description = parts[0]?.trim();
      const quantityStr = parts[1]?.replace(/[^\d.]/g, '');
      const rateStr = parts[2]?.replace(/[^\d.]/g, '');
      
      const quantity = parseFloat(quantityStr) || 0;
      const rate = parseFloat(rateStr) || 0;
      const total = quantity * rate;
      
      if (description && description.length > 5 && quantity > 0 && rate > 0) {
        return {
          description,
          quantity,
          rate,
          total,
          unit: getUnitFromDescription(description)
        };
      }
    }
  } catch (error) {
    console.error('Error parsing item line:', error);
  }
  
  return null;
};

// Helper to determine unit from description
const getUnitFromDescription = (description) => {
  const desc = description.toLowerCase();
  if (desc.includes('sq.ft') || desc.includes('sqft') || desc.includes('sq ft')) return 'sq.ft';
  if (desc.includes('nos') || desc.includes('numbers') || desc.includes('pcs')) return 'nos';
  if (desc.includes('meter') || desc.includes('metre') || desc.includes('mtr')) return 'meter';
  if (desc.includes('kg') || desc.includes('kilogram')) return 'kg';
  if (desc.includes('litre') || desc.includes('liter') || desc.includes('ltr')) return 'litre';
  if (desc.includes('person') || desc.includes('per person')) return 'person';
  return 'unit';
};

// Helper function to parse dates
const parseDate = (dateString) => {
  try {
    if (!dateString) return new Date();
    
    // Handle DD.MM.YYYY format (01.11.2025)
    const match = dateString.match(/(\d{2})\.(\d{2})\.(\d{4})/);
    if (match) {
      const [, day, month, year] = match;
      return new Date(year, month - 1, day);
    }
    
    return new Date();
  } catch (error) {
    console.error('Error parsing date:', dateString, error);
    return new Date();
  }
};

// Upload Vendor PO PDF (main function) - UPDATED TO HANDLE MANUAL ENTRY
exports.uploadVendorPoPdf = async (req, res) => {
  try {
    const { 
      project_id, 
      po_number,
      vendor_name,
      vendor_gstin,
      site_location,
      work_description,
      total_amount,
      po_date,
      items,
      status = 'active'
    } = req.body;

    if (!req.file) {
      return res.status(400).json({ message: "PDF file is required" });
    }

    if (!project_id) {
      return res.status(400).json({ message: "Project ID is required" });
    }

    const uploadsDir = ensureUploadsDir();
    const pdfFilePath = path.join(uploadsDir, req.file.filename);
    const pdfFileStoragePath = `uploads/vendor_po/${req.file.filename}`;

    let parsedVendorPoData = {
      items: [],
      meta_data: {
        extraction_method: 'manual',
        parsing_success: false
      }
    };

    // Check if we have manual data (means parsing failed and user provided data)
    const hasManualData = po_number || vendor_name || vendor_gstin || site_location || work_description;

    if (!hasManualData) {
      // Try to parse PDF only if no manual data provided
      try {
        console.log('Attempting to parse Vendor PO PDF...');
        parsedVendorPoData = await parseVendorPoPdf(pdfFilePath);
        
        if (parsedVendorPoData.po_number || parsedVendorPoData.vendor_name) {
          console.log('✓ Successfully parsed some data from PDF');
          parsedVendorPoData.meta_data.parsing_success = true;
        } else {
          console.log('✗ Could not extract data from PDF');
          parsedVendorPoData.meta_data.parsing_success = false;
          
          // Return early to ask for manual entry
          return res.status(200).json({ 
            message: "Could not parse details from uploaded file. Please enter details manually.",
            requires_manual_entry: true,
            parsed_data: parsedVendorPoData
          });
        }
      } catch (parseError) {
        console.error('PDF parsing failed:', parseError.message);
        parsedVendorPoData.meta_data.parsing_success = false;
        parsedVendorPoData.meta_data.parse_error = parseError.message;
        
        // Return to ask for manual entry
        return res.status(200).json({ 
          message: "Could not parse details from uploaded file. Please enter details manually.",
          requires_manual_entry: true,
          parsed_data: parsedVendorPoData
        });
      }
    }

    // Use manual data if provided (overrides parsed data)
    const finalVendorPoData = {
      po_number: po_number || parsedVendorPoData.po_number,
      vendor_name: vendor_name || parsedVendorPoData.vendor_name || '',
      vendor_gstin: vendor_gstin || parsedVendorPoData.vendor_gstin || '',
      site_location: site_location || parsedVendorPoData.site_location || '',
      work_description: work_description || parsedVendorPoData.work_description || '',
      total_amount: total_amount ? parseFloat(total_amount) : (parsedVendorPoData.total_amount || 0),
      po_date: po_date ? new Date(po_date) : (parsedVendorPoData.po_date || new Date()),
      items: items ? JSON.parse(items) : (parsedVendorPoData.items || []),
      meta_data: parsedVendorPoData.meta_data
    };

    // If no PO number after all attempts, return error
    if (!finalVendorPoData.po_number) {
      return res.status(400).json({ 
        message: "PO Number is required. Please provide it manually.",
        requires_manual_entry: true
      });
    }

    // Check if PO number already exists for this project
    const [existingPo] = await db.execute(
      "SELECT * FROM vendor_po WHERE po_number = ? AND project_id = ?",
      [finalVendorPoData.po_number, project_id]
    );

    if (existingPo.length > 0) {
      try {
        if (fs.existsSync(pdfFilePath)) {
          fs.unlinkSync(pdfFilePath);
        }
      } catch (cleanupError) {
        console.error("Error cleaning up file:", cleanupError);
      }
      return res.status(400).json({ 
        message: "PO number already exists for this project. Please use a different number.",
        duplicate_po: existingPo[0]
      });
    }

    // Create new Vendor PO record
    const [result] = await db.execute(`
      INSERT INTO vendor_po (
        project_id, vendor_name, vendor_gstin, po_number, po_date,
        total_amount, site_location, work_description, items, meta_data, pdf_file_path, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      project_id,
      finalVendorPoData.vendor_name,
      finalVendorPoData.vendor_gstin,
      finalVendorPoData.po_number,
      finalVendorPoData.po_date,
      finalVendorPoData.total_amount,
      finalVendorPoData.site_location,
      finalVendorPoData.work_description,
      JSON.stringify(finalVendorPoData.items),
      JSON.stringify(finalVendorPoData.meta_data),
      pdfFileStoragePath,
      status
    ]);

    // Fetch the created Vendor PO
    const [vendorPoRows] = await db.execute(
      "SELECT * FROM vendor_po WHERE id = ?",
      [result.insertId]
    );

    const vendorPo = vendorPoRows[0];
    // Parse JSON fields for response
    vendorPo.items = typeof vendorPo.items === 'string' ? JSON.parse(vendorPo.items) : vendorPo.items;
    vendorPo.meta_data = typeof vendorPo.meta_data === 'string' ? JSON.parse(vendorPo.meta_data) : vendorPo.meta_data;

    res.json({
      message: "Vendor PO uploaded successfully",
      vendor_po: vendorPo,
      pdf_path: pdfFileStoragePath,
      parsed_automatically: parsedVendorPoData.meta_data.parsing_success,
      parsed_data: parsedVendorPoData
    });

  } catch (err) {
    console.error("Error uploading Vendor PO PDF:", err);
    
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
      message: "Error uploading Vendor PO PDF", 
      error: err.message 
    });
  }
};

// Keep all other functions exactly the same
exports.getVendorPosByProject = async (req, res) => {
  try {
    const { project_id } = req.params;

    const [rows] = await db.execute(`
      SELECT vp.*, p.project_name
      FROM vendor_po vp
      LEFT JOIN projects p ON vp.project_id = p.id
      WHERE vp.project_id = ?
      ORDER BY vp.created_at DESC
    `, [project_id]);

    // Parse JSON fields
    const vendorPos = rows.map(po => ({
      ...po,
      items: typeof po.items === 'string' ? JSON.parse(po.items) : po.items,
      meta_data: typeof po.meta_data === 'string' ? JSON.parse(po.meta_data) : po.meta_data
    }));

    res.json(vendorPos);
  } catch (err) {
    console.error("Error fetching vendor POs:", err);
    res.status(500).json({ message: "Error fetching vendor POs", error: err.message });
  }
};

exports.getVendorPo = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.execute(`
      SELECT vp.*, p.project_name
      FROM vendor_po vp
      LEFT JOIN projects p ON vp.project_id = p.id
      WHERE vp.id = ?
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ message: "Vendor PO not found" });
    }

    const vendorPo = rows[0];
    // Parse JSON fields
    vendorPo.items = typeof vendorPo.items === 'string' ? JSON.parse(vendorPo.items) : vendorPo.items;
    vendorPo.meta_data = typeof vendorPo.meta_data === 'string' ? JSON.parse(vendorPo.meta_data) : vendorPo.meta_data;

    res.json(vendorPo);
  } catch (err) {
    console.error("Error fetching vendor PO:", err);
    res.status(500).json({ message: "Error fetching vendor PO", error: err.message });
  }
};

exports.serveVendorPoPdf = async (req, res) => {
  try {
    const { filename } = req.params;
    
    const uploadsDir = ensureUploadsDir();
    const filePath = path.join(uploadsDir, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ 
        message: "PDF file not found",
        path: filePath,
        filename: filename
      });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

  } catch (err) {
    console.error("Error serving PDF:", err);
    res.status(500).json({ 
      message: "Error serving PDF", 
      error: err.message,
      filename: req.params.filename
    });
  }
};

exports.deleteVendorPo = async (req, res) => {
  try {
    const { id } = req.params;

    // Get PO details to delete associated PDF file
    const [poRows] = await db.execute(
      "SELECT pdf_file_path FROM vendor_po WHERE id = ?",
      [id]
    );

    if (poRows.length === 0) {
      return res.status(404).json({ message: "Vendor PO not found" });
    }

    const po = poRows[0];

    // Delete the PO record
    const [result] = await db.execute(
      "DELETE FROM vendor_po WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Vendor PO not found" });
    }

    // Delete associated PDF file
    if (po.pdf_file_path) {
      try {
        const filename = po.pdf_file_path.split('/').pop();
        const filePath = path.join(ensureUploadsDir(), filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (fileError) {
        console.error("Error deleting PDF file:", fileError);
      }
    }

    res.json({ message: "Vendor PO deleted successfully" });
  } catch (err) {
    console.error("Error deleting vendor PO:", err);
    res.status(500).json({ message: "Error deleting vendor PO", error: err.message });
  }
};