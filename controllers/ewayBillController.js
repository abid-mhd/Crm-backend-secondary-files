const db = require("../config/db");
const path = require("path");
const fs = require("fs");
const PDFParser = require("pdf2json");

// Ensure uploads directory exists
const ensureUploadsDir = () => {
  const uploadsDir = path.join(__dirname, '../uploads/ewaybills');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  return uploadsDir;
};

// Enhanced PDF parsing with better text extraction
const parseEwayBillPdf = (filePath) => {
  return new Promise((resolve, reject) => {
    const pdfParser = new PDFParser();
    
    pdfParser.on("pdfParser_dataError", errData => {
      console.error('PDF parsing error:', errData.parserError);
      reject(new Error('Failed to parse PDF: ' + errData.parserError));
    });
    
    pdfParser.on("pdfParser_dataReady", pdfData => {
      try {
        // Get raw text content
        let text = pdfParser.getRawTextContent();
        
        console.log('=== FULL PDF TEXT CONTENT ===');
        console.log(text);
        console.log('=== END PDF TEXT ===');
        
        // If getRawTextContent is empty, try to extract from pdfData directly
        if (!text || text.trim().length === 0) {
          text = extractTextFromPdfData(pdfData);
          console.log('=== EXTRACTED TEXT FROM PDF DATA ===');
          console.log(text);
          console.log('=== END EXTRACTED TEXT ===');
        }
        
        if (!text || text.trim().length === 0) {
          reject(new Error('No text content found in PDF. The PDF might be scanned or image-based.'));
          return;
        }
        
        const ewayBillData = parseEwayBillText(text);
        
        console.log('=== PARSED DATA ===');
        console.log(JSON.stringify(ewayBillData, null, 2));
        console.log('=== END PARSED DATA ===');
        
        // Validate that we at least got the e-way bill number
        if (!ewayBillData.eway_bill_number) {
          reject(new Error('Could not extract E-Way Bill number from PDF. Please provide it manually.'));
          return;
        }
        
        resolve(ewayBillData);
      } catch (error) {
        console.error('Error processing PDF text:', error);
        reject(new Error('Failed to process PDF text: ' + error.message));
      }
    });
    
    pdfParser.loadPDF(filePath);
  });
};

// Extract text from PDF data structure
const extractTextFromPdfData = (pdfData) => {
  try {
    let text = '';
    
    if (pdfData.Pages) {
      pdfData.Pages.forEach(page => {
        if (page.Texts) {
          page.Texts.forEach(textObj => {
            if (textObj.R) {
              textObj.R.forEach(r => {
                if (r.T) {
                  // Decode URI component
                  const decodedText = decodeURIComponent(r.T);
                  text += decodedText + ' ';
                }
              });
            }
          });
          text += '\n';
        }
      });
    }
    
    return text;
  } catch (error) {
    console.error('Error extracting text from PDF data:', error);
    return '';
  }
};

// Enhanced text parsing based on your PDF format
const parseEwayBillText = (text) => {
  const ewayBillData = {};
  
  // Clean up the text - remove extra spaces and normalize
  const cleanText = text.replace(/\s+/g, ' ').trim();
  console.log('=== CLEANED TEXT ===');
  console.log(cleanText);
  console.log('=== END CLEANED TEXT ===');

  // Parse E-Way Bill Number - Pattern: "E-Way Bill No: 5918 7498 1684"
  const ewayBillPatterns = [
    /E-Way Bill No:\s*(\d{4})\s*(\d{4})\s*(\d{4})/i,
    /E-Way\s*Bill\s*No:\s*(\d{4})\s*(\d{4})\s*(\d{4})/i,
    /E-Way\s*Bill\s*No\s*(\d{4})\s*(\d{4})\s*(\d{4})/i,
    /(\d{4})\s*(\d{4})\s*(\d{4})/
  ];

  for (const pattern of ewayBillPatterns) {
    const match = cleanText.match(pattern);
    if (match) {
      // If we have 3 capture groups, concatenate them
      if (match.length === 4) {
        ewayBillData.eway_bill_number = match[1] + match[2] + match[3];
      } else {
        ewayBillData.eway_bill_number = match[1].replace(/\s/g, '');
      }
      console.log(`✓ Found E-Way Bill Number: ${ewayBillData.eway_bill_number}`);
      break;
    }
  }

  // Parse E-Way Bill Date - Pattern: "E-Way Bill Date: 10/09/2025 05:15 PM"
  const datePatternsMap = {
    eway_bill_date: [
      /E-Way Bill Date:\s*(\d{2}\/\d{2}\/\d{4})\s*(\d{1,2}:\d{2}\s*[AP]M)/i,
      /E-Way\s*Bill\s*Date:\s*(\d{2}\/\d{2}\/\d{4})/i
    ],
    valid_from: [
      /Valid From:\s*(\d{2}\/\d{2}\/\d{4})\s*(\d{1,2}:\d{2}\s*[AP]M)\s*\[(\d+)Kms?\]/i,
      /Valid\s*From:\s*(\d{2}\/\d{2}\/\d{4})/i
    ],
    valid_until: [
      /Valid Until:\s*(\d{2}\/\d{2}\/\d{4})/i,
      /Valid\s*Until:\s*(\d{2}\/\d{2}\/\d{4})/i
    ],
    document_date: [
      /Document Date\s*(\d{2}\/\d{2}\/\d{4})/i,
      /Document\s*Date:\s*(\d{2}\/\d{2}\/\d{4})/i
    ]
  };

  for (const [field, patterns] of Object.entries(datePatternsMap)) {
    for (const pattern of patterns) {
      const match = cleanText.match(pattern);
      if (match) {
        ewayBillData[field] = parseDate(match[1]);
        
        // Extract distance if present
        if (field === 'valid_from' && match[3]) {
          ewayBillData.distance_km = parseInt(match[3]);
          console.log(`✓ Found Distance: ${ewayBillData.distance_km} km`);
        }
        
        console.log(`✓ Found ${field}: ${match[1]}`);
        break;
      }
    }
  }

  // Parse Generated By - Pattern: "Generated By: 33GJXPS2471H1ZJ - Saranya"
  const generatedByMatch = cleanText.match(/Generated By:\s*([A-Z0-9]+)\s*-\s*([^Valid]+)/i);
  if (generatedByMatch) {
    ewayBillData.generated_by_gstin = generatedByMatch[1].trim();
    ewayBillData.generated_by_name = generatedByMatch[2].trim();
    console.log(`✓ Found Generated By: ${ewayBillData.generated_by_gstin} - ${ewayBillData.generated_by_name}`);
  }

  // Parse Supplier GSTIN - Pattern: "GSTIN of Supplier 33GJXPS2471H1ZJ,Icebergs"
  const supplierMatch = cleanText.match(/GSTIN of Supplier\s*([A-Z0-9]+)\s*,\s*([^Place]+)/i);
  if (supplierMatch) {
    ewayBillData.supplier_gstin = supplierMatch[1].trim();
    ewayBillData.supplier_name = supplierMatch[2].trim();
    console.log(`✓ Found Supplier: ${ewayBillData.supplier_gstin} - ${ewayBillData.supplier_name}`);
  }

  // Parse Place of Dispatch - Pattern: "Place of Dispatch Chennai,TAMIL NADU-600096"
  const dispatchMatch = cleanText.match(/Place of Dispatch\s*([^GSTIN]+?)(?=GSTIN|$)/i);
  if (dispatchMatch) {
    ewayBillData.place_of_dispatch = dispatchMatch[1].trim();
    console.log(`✓ Found Place of Dispatch: ${ewayBillData.place_of_dispatch}`);
  }

  // Parse Recipient GSTIN - Pattern: "GSTIN of Recipient 33AAACJ4323N1ZN ,JSW STEEL LIMITED"
  const recipientMatch = cleanText.match(/GSTIN of Recipient\s*([A-Z0-9]+)\s*,\s*([^Place]+)/i);
  if (recipientMatch) {
    ewayBillData.recipient_gstin = recipientMatch[1].trim();
    ewayBillData.recipient_name = recipientMatch[2].trim();
    console.log(`✓ Found Recipient: ${ewayBillData.recipient_gstin} - ${ewayBillData.recipient_name}`);
  }

  // Parse Place of Delivery - Pattern: "Place of Delivery METTUR TALUK,TAMIL NADU-636453"
  const deliveryMatch = cleanText.match(/Place of Delivery\s*([^Document]+?)(?=Document|$)/i);
  if (deliveryMatch) {
    ewayBillData.place_of_delivery = deliveryMatch[1].trim();
    console.log(`✓ Found Place of Delivery: ${ewayBillData.place_of_delivery}`);
  }

  // Parse Document Number - Pattern: "Document No. ICE/25-26/INV/21"
  const docNumberMatch = cleanText.match(/Document No\.\s*([^\s]+)/i);
  if (docNumberMatch) {
    ewayBillData.document_number = docNumberMatch[1].trim();
    console.log(`✓ Found Document Number: ${ewayBillData.document_number}`);
  }

  // Parse Transaction Type - Pattern: "Transaction Type: Regular"
  const transactionMatch = cleanText.match(/Transaction Type:\s*([^\s]+)/i);
  if (transactionMatch) {
    ewayBillData.transaction_type = transactionMatch[1].trim();
    console.log(`✓ Found Transaction Type: ${ewayBillData.transaction_type}`);
  }

  // Parse Value of Goods - Pattern: "Value of Goods 1050200"
  const valueMatch = cleanText.match(/Value of Goods\s*(\d+)/i);
  if (valueMatch) {
    ewayBillData.value_of_goods = parseFloat(valueMatch[1]);
    console.log(`✓ Found Value of Goods: ${ewayBillData.value_of_goods}`);
  }

  // Parse HSN Code - Pattern: "HSN Code 84186990 - EQPT SPY, PLANT, SMS CHILLER PLANT, 850 TR"
  const hsnMatch = cleanText.match(/HSN Code\s*(\d+)/i);
  if (hsnMatch) {
    ewayBillData.hsn_code = hsnMatch[1].trim();
    console.log(`✓ Found HSN Code: ${ewayBillData.hsn_code}`);
  }

  // Parse Reason for Transportation - Pattern: "Reason for Transportation Outward - Supply"
  const reasonMatch = cleanText.match(/Reason for Transportation\s*([^Transporter]+?)(?=Transporter|Part|$)/i);
  if (reasonMatch) {
    ewayBillData.reason_for_transportation = reasonMatch[1].trim();
    console.log(`✓ Found Reason: ${ewayBillData.reason_for_transportation}`);
  }

  // Parse Vehicle Number - Pattern: "Road TN28BH7363"
  const vehicleMatch = cleanText.match(/Road\s*([A-Z0-9]+)/i);
  if (vehicleMatch) {
    ewayBillData.vehicle_number = vehicleMatch[1].trim();
    console.log(`✓ Found Vehicle Number: ${ewayBillData.vehicle_number}`);
  }

  // Parse Portal - Pattern: "Portal: 1"
  const portalMatch = cleanText.match(/Portal:\s*(\d+)/i);
  if (portalMatch) {
    ewayBillData.portal_used = portalMatch[1].trim();
    console.log(`✓ Found Portal: ${ewayBillData.portal_used}`);
  }

  // Set defaults
  ewayBillData.mode_of_transport = ewayBillData.mode_of_transport || 'Road';
  ewayBillData.status = 'active';
  
  return ewayBillData;
};

// Helper function to parse dates
const parseDate = (dateString) => {
  try {
    if (!dateString) return new Date();
    
    // Handle dates in format DD/MM/YYYY
    const dateMatch = dateString.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (dateMatch) {
      const [, day, month, year] = dateMatch;
      return new Date(year, month - 1, day);
    }
    
    return new Date();
  } catch (error) {
    console.error('Error parsing date:', dateString, error);
    return new Date();
  }
};

// Upload e-Way Bill PDF with manual fallback
exports.uploadEwayBillPdf = async (req, res) => {
  try {
    const { invoice_id, manual_eway_bill_number } = req.body;

    if (!req.file) {
      return res.status(400).json({ message: "PDF file is required" });
    }

    if (!invoice_id) {
      return res.status(400).json({ message: "Invoice ID is required" });
    }

    const uploadsDir = ensureUploadsDir();
    const pdfFilePath = path.join(uploadsDir, req.file.filename);
    const pdfFileStoragePath = `/uploads/ewaybills/${req.file.filename}`;

    let parsedEwayBillData = {};
    let ewayBillNumber = manual_eway_bill_number;

    // Try to parse PDF if no manual number provided
    if (!ewayBillNumber) {
      try {
        console.log('Attempting to parse PDF...');
        parsedEwayBillData = await parseEwayBillPdf(pdfFilePath);
        ewayBillNumber = parsedEwayBillData.eway_bill_number;
        
        if (!ewayBillNumber) {
          throw new Error('Could not extract E-Way Bill number from PDF. Please provide it manually.');
        }
        
        console.log('✓ Successfully parsed E-Way Bill:', ewayBillNumber);
      } catch (parseError) {
        console.error('PDF parsing failed:', parseError.message);
        
        if (!manual_eway_bill_number) {
          // Clean up file and return error suggesting manual entry
          fs.unlinkSync(pdfFilePath);
          return res.status(400).json({ 
            message: "PDF parsing failed. Please provide E-Way Bill number manually.",
            error: parseError.message,
            requires_manual_entry: true
          });
        }
      }
    }

    // Use manual number if provided
    if (manual_eway_bill_number && !ewayBillNumber) {
      ewayBillNumber = manual_eway_bill_number;
      parsedEwayBillData.eway_bill_number = ewayBillNumber;
    }

    // Check if e-Way Bill number already exists (prevent duplicate numbers)
    const [existingByNumber] = await db.execute(
      "SELECT * FROM eway_bills WHERE eway_bill_number = ?",
      [ewayBillNumber]
    );

    if (existingByNumber.length > 0) {
      fs.unlinkSync(pdfFilePath);
      return res.status(400).json({ 
        message: "E-Way Bill number already exists. Please use a different number.",
        duplicate_eway_bill: existingByNumber[0]
      });
    }

    // Check if e-Way Bill already exists for this specific invoice
    const [existingForInvoice] = await db.execute(
      "SELECT * FROM eway_bills WHERE invoice_id = ?",
      [invoice_id]
    );

    if (existingForInvoice.length > 0) {
      // Update existing e-way bill for this invoice
      const existingEwayBill = existingForInvoice[0];
      
      await db.execute(
        `UPDATE eway_bills SET 
          eway_bill_number = ?,
          eway_bill_date = ?,
          valid_from = ?,
          valid_until = ?,
          pdf_file_path = ?,
          updated_at = NOW(),
          value_of_goods = ?,
          supplier_gstin = ?,
          supplier_name = ?,
          recipient_gstin = ?,
          recipient_name = ?
         WHERE id = ?`,
        [
          ewayBillNumber,
          parsedEwayBillData.eway_bill_date || new Date(),
          parsedEwayBillData.valid_from || new Date(),
          parsedEwayBillData.valid_until || new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
          pdfFileStoragePath,
          parsedEwayBillData.value_of_goods || 0,
          parsedEwayBillData.supplier_gstin || '',
          parsedEwayBillData.supplier_name || '',
          parsedEwayBillData.recipient_gstin || '',
          parsedEwayBillData.recipient_name || '',
          existingEwayBill.id
        ]
      );

      // Update invoice with eway_bill_number
      await db.execute(
        "UPDATE invoices SET eway_bill_number = ?, updatedAt = NOW() WHERE id = ?",
        [ewayBillNumber, invoice_id]
      );

      // Fetch the updated e-Way Bill
      const [updatedRows] = await db.execute(
        "SELECT * FROM eway_bills WHERE id = ?",
        [existingEwayBill.id]
      );

      return res.json({
        message: "E-Way Bill updated successfully",
        eway_bill: updatedRows[0],
        pdf_path: pdfFileStoragePath,
        parsed_automatically: !!parsedEwayBillData.eway_bill_number,
        parsed_data: parsedEwayBillData,
        was_updated: true
      });
    }

    // Get invoice details for new e-way bill
    const [invoiceRows] = await db.execute(`
      SELECT i.*, p.partyName as client_name, p.gstin as client_gstin,
             p.billingAddress as client_address, p.shippingAddress as client_shipping_address
      FROM invoices i 
      LEFT JOIN parties p ON i.clientId = p.id 
      WHERE i.id = ?
    `, [invoice_id]);

    if (invoiceRows.length === 0) {
      fs.unlinkSync(pdfFilePath);
      return res.status(404).json({ message: "Invoice not found" });
    }

    const invoice = invoiceRows[0];

    // Create new e-Way Bill record
    const [result] = await db.execute(`
      INSERT INTO eway_bills (
        invoice_id, eway_bill_number, eway_bill_date, valid_from, valid_until,
        generated_by_gstin, generated_by_name, supplier_gstin, supplier_name,
        place_of_dispatch, recipient_gstin, recipient_name, place_of_delivery,
        document_number, document_date, transaction_type, value_of_goods, hsn_code,
        reason_for_transportation, transporter_name, vehicle_number,
        distance_km, mode_of_transport, status, pdf_file_path, portal_used
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      invoice_id,
      ewayBillNumber,
      parsedEwayBillData.eway_bill_date || new Date(),
      parsedEwayBillData.valid_from || new Date(),
      parsedEwayBillData.valid_until || new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      parsedEwayBillData.generated_by_gstin || '',
      parsedEwayBillData.generated_by_name || '',
      parsedEwayBillData.supplier_gstin || '',
      parsedEwayBillData.supplier_name || '',
      parsedEwayBillData.place_of_dispatch || '',
      parsedEwayBillData.recipient_gstin || invoice.client_gstin || '',
      parsedEwayBillData.recipient_name || invoice.client_name || '',
      parsedEwayBillData.place_of_delivery || '',
      parsedEwayBillData.document_number || invoice.invoiceNumber,
      parsedEwayBillData.document_date || invoice.date,
      parsedEwayBillData.transaction_type || 'Regular',
      parsedEwayBillData.value_of_goods || invoice.total || 0,
      parsedEwayBillData.hsn_code || '',
      parsedEwayBillData.reason_for_transportation || 'Outward - Supply',
      parsedEwayBillData.transporter_name || '',
      parsedEwayBillData.vehicle_number || '',
      parsedEwayBillData.distance_km || 0,
      parsedEwayBillData.mode_of_transport || 'Road',
      'active',
      pdfFileStoragePath,
      parsedEwayBillData.portal_used || '1'
    ]);

    const ewayBillId = result.insertId;

    // Update invoice with eway_bill_number
    await db.execute(
      "UPDATE invoices SET eway_bill_number = ?, updatedAt = NOW() WHERE id = ?",
      [ewayBillNumber, invoice_id]
    );

    // Fetch the created e-Way Bill
    const [ewayBillRows] = await db.execute(
      "SELECT * FROM eway_bills WHERE id = ?",
      [ewayBillId]
    );

    res.json({
      message: "E-Way Bill PDF uploaded successfully",
      eway_bill: ewayBillRows[0],
      pdf_path: pdfFileStoragePath,
      parsed_automatically: !!parsedEwayBillData.eway_bill_number,
      parsed_data: parsedEwayBillData,
      was_updated: false
    });

  } catch (err) {
    console.error("Error uploading e-Way Bill PDF:", err);
    
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
      message: "Error uploading e-Way Bill PDF", 
      error: err.message 
    });
  }
};

// Generate e-Way Bill
exports.generateEwayBill = async (req, res) => {
  try {
    const { invoice_id, transporter_name, vehicle_number, distance_km, reason_for_transportation } = req.body;

    // Validate required fields
    if (!invoice_id) {
      return res.status(400).json({ message: "Invoice ID is required" });
    }

    // Fetch invoice details
    const [invoiceRows] = await db.execute(`
      SELECT i.*, p.partyName as client_name, p.gstin as client_gstin, 
             p.billingAddress as client_address, p.shippingAddress as client_shipping_address
      FROM invoices i 
      LEFT JOIN parties p ON i.clientId = p.id 
      WHERE i.id = ?
    `, [invoice_id]);

    if (invoiceRows.length === 0) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const invoice = invoiceRows[0];

    // Check if e-Way Bill already exists for this invoice
    const [existingEwayBills] = await db.execute(
      "SELECT * FROM eway_bills WHERE invoice_id = ?",
      [invoice_id]
    );

    if (existingEwayBills.length > 0) {
      return res.status(400).json({ 
        message: "E-Way Bill already exists for this invoice",
        eway_bill: existingEwayBills[0]
      });
    }

    // Generate e-Way Bill number
    const ewayBillNumber = generateEwayBillNumber();
    const ewayBillDate = new Date();
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + 2); // Valid for 2 days

    // Extract HSN codes from invoice items
    const hsnCodes = await getHsnCodesFromInvoice(invoice_id);

    // Create e-Way Bill
    const [result] = await db.execute(`
      INSERT INTO eway_bills (
        invoice_id, eway_bill_number, eway_bill_date, valid_from, valid_until,
        generated_by_gstin, generated_by_name, supplier_gstin, supplier_name,
        place_of_dispatch, recipient_gstin, recipient_name, place_of_delivery,
        document_number, document_date, value_of_goods, hsn_code,
        reason_for_transportation, transporter_name, vehicle_number,
        distance_km, mode_of_transport, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      invoice_id,
      ewayBillNumber,
      ewayBillDate,
      ewayBillDate,
      validUntil,
      '33GJXPS2471H1ZJ', // Your company GSTIN
      'Icebergs', // Your company name
      '33GJXPS2471H1ZJ', // Supplier GSTIN (same as yours for outward supply)
      'Icebergs', // Supplier name
      extractCityStateFromAddress(invoice.client_address || ''),
      invoice.client_gstin || '',
      invoice.client_name || '',
      extractCityStateFromAddress(invoice.client_shipping_address || ''),
      invoice.invoiceNumber,
      invoice.date,
      invoice.total || 0,
      hsnCodes.length > 0 ? hsnCodes[0] : '',
      reason_for_transportation || 'Outward - Supply',
      transporter_name,
      vehicle_number,
      distance_km || 0,
      'Road',
      'active'
    ]);

    // Update invoice with e-Way Bill number
    await db.execute(
      "UPDATE invoices SET eway_bill_number = ?, updatedAt = NOW() WHERE id = ?",
      [ewayBillNumber, invoice_id]
    );

    // Fetch the created e-Way Bill
    const [ewayBillRows] = await db.execute(
      "SELECT * FROM eway_bills WHERE id = ?",
      [result.insertId]
    );

    res.status(201).json({
      message: "E-Way Bill generated successfully",
      eway_bill: ewayBillRows[0]
    });

  } catch (err) {
    console.error("Error generating e-Way Bill:", err);
    res.status(500).json({ message: "Error generating e-Way Bill", error: err.message });
  }
};


// Get invoices for e-Way Bill (New endpoint)
exports.getEwayBills = async (req, res) => {
  try {
    const { project_id } = req.params;

    const [rows] = await db.execute(`
      SELECT eb.*, i.invoiceNumber, i.total, i.date as invoice_date,
             p.partyName as client_name, p.gstin as client_gstin,
             eb.eway_bill_number, eb.eway_bill_date, eb.status, 
             eb.valid_until, eb.value_of_goods, eb.pdf_file_path
      FROM eway_bills eb
      LEFT JOIN invoices i ON eb.invoice_id = i.id
      LEFT JOIN parties p ON i.clientId = p.id
      WHERE i.project_id = ? 
        AND i.type IN ('sales', 'purchase_order', 'purchase')
      ORDER BY eb.created_at DESC
    `, [project_id]);

    res.json(rows);
  } catch (err) {
    console.error("Error fetching ewaybills:", err);
    res.status(500).json({ message: "Error fetching ewaybills", error: err.message });
  }
};

// Get invoices for e-Way Bill generation
exports.getInvoicesForEwayBill = async (req, res) => {
  try {
    const { project_id } = req.params;

    if (!project_id) {
      return res.status(400).json({ message: "Project ID is required" });
    }

    const [rows] = await db.execute(`
      SELECT 
        i.id,
        i.invoiceNumber,
        i.date,
        i.total,
        i.type,
        i.status,
        i.eway_bill_number,
        p.partyName as client_name,
        p.gstin as client_gstin,
        p.billingAddress as client_address,
        p.shippingAddress as client_shipping_address,
        eb.id as existing_ewaybill_id
      FROM invoices i
      LEFT JOIN parties p ON i.clientId = p.id
      LEFT JOIN eway_bills eb ON eb.invoice_id = i.id
      WHERE i.project_id = ? 
        AND i.type = 'sales'  -- Only sales invoices
        AND eb.id IS NULL  -- Only invoices without existing e-way bills
        AND i.status = 'paid'  -- Only paid invoices
      ORDER BY i.date DESC, i.invoiceNumber DESC
    `, [project_id]);

    // Transform the data
    const invoices = rows.map(invoice => ({
      ...invoice,
      eway_bill_status: 'not_generated',
      can_generate_ewaybill: true, // All invoices in this query are eligible
      has_existing_ewaybill: false // Since we filtered by eb.id IS NULL
    }));

    res.json({
      success: true,
      data: invoices,
      count: invoices.length
    });

  } catch (err) {
    console.error("Error fetching invoices for e-Way Bill:", err);
    res.status(500).json({ 
      message: "Error fetching invoices for e-Way Bill", 
      error: err.message 
    });
  }
};

// Get e-Way Bills by invoice
exports.getEwayBillsByInvoice = async (req, res) => {
  try {
    const { invoice_id } = req.params;

    const [rows] = await db.execute(`
      SELECT eb.*, i.invoiceNumber, i.total, i.date as invoice_date,
             p.partyName as client_name, p.gstin as client_gstin,eb.eway_bill_number,eb.eway_bill_date,eb.statuseb.valid_until,eb.value_of_goods,eb.pdf_file_path
      FROM eway_bills eb
      LEFT JOIN invoices i ON eb.invoice_id = i.id
      LEFT JOIN parties p ON i.clientId = p.id
      WHERE eb.invoice_id = ?
      ORDER BY eb.created_at DESC
    `, [invoice_id]);

    res.json(rows);
  } catch (err) {
    console.error("Error fetching e-Way Bills:", err);
    res.status(500).json({ message: "Error fetching e-Way Bills", error: err.message });
  }
};

// Get single e-Way Bill
exports.getEwayBill = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.execute(`
      SELECT eb.*, i.invoiceNumber, i.total, i.date as invoice_date,
             p.partyName as client_name, p.gstin as client_gstin,
             p.billingAddress as client_address, p.shippingAddress as client_shipping_address
      FROM eway_bills eb
      LEFT JOIN invoices i ON eb.invoice_id = i.id
      LEFT JOIN parties p ON i.clientId = p.id
      WHERE eb.id = ?
    `, [id]);

    if (rows.length === 0) {
      return res.status(404).json({ message: "E-Way Bill not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching e-Way Bill:", err);
    res.status(500).json({ message: "Error fetching e-Way Bill", error: err.message });
  }
};

// Serve e-Way Bill PDF
exports.serveEwayBillPdf = async (req, res) => {
  try {
    const { filename } = req.params;
    
    // Ensure upload directory exists
    const uploadsDir = ensureUploadsDir();
    const filePath = path.join(uploadsDir, filename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ 
        message: "PDF file not found",
        path: filePath,
        filename: filename
      });
    }

    // Set appropriate headers for PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);

    // Stream the file
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

// Get all e-Way Bills
exports.getAllEwayBills = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT eb.*, i.invoiceNumber, i.total, i.date as invoice_date,
             p.partyName as client_name, p.gstin as client_gstin
      FROM eway_bills eb
      LEFT JOIN invoices i ON eb.invoice_id = i.id
      LEFT JOIN parties p ON i.clientId = p.id
    `;

    let countQuery = `SELECT COUNT(*) as total FROM eway_bills eb`;
    const queryParams = [];
    const countParams = [];

    if (status) {
      query += ` WHERE eb.status = ?`;
      countQuery += ` WHERE eb.status = ?`;
      queryParams.push(status);
      countParams.push(status);
    }

    query += ` ORDER BY eb.created_at DESC LIMIT ? OFFSET ?`;
    
    // Always add limit and offset to queryParams
    queryParams.push(parseInt(limit), offset);

    console.log('Query:', query);
    console.log('Query Params:', queryParams);
    console.log('Count Query:', countQuery);
    console.log('Count Params:', countParams);

    // Execute queries with proper parameters
    const [rows] = await db.execute(query, queryParams);
    const [countRows] = await db.execute(countQuery, countParams);

    res.json({
      eway_bills: rows,
      total: countRows[0].total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(countRows[0].total / limit)
    });
  } catch (err) {
    console.error("Error fetching e-Way Bills:", err);
    res.status(500).json({ message: "Error fetching e-Way Bills", error: err.message });
  }
};

exports.getEwayBillsByProject = async (req, res) => {
  try {
    const { project_id } = req.params;

    const [rows] = await db.execute(`
      SELECT eb.*, i.invoiceNumber, i.total, i.date as invoice_date,
             p.partyName as client_name, p.gstin as client_gstin
      FROM eway_bills eb
      LEFT JOIN invoices i ON eb.invoice_id = i.id
      LEFT JOIN parties p ON i.clientId = p.id
      WHERE i.project_id = ?
      ORDER BY eb.created_at DESC
    `, [project_id]);

    res.json(rows);
  } catch (err) {
    console.error("Error fetching e-Way Bills by project:", err);
    res.status(500).json({ message: "Error fetching e-Way Bills", error: err.message });
  }
};

// Cancel e-Way Bill
// Cancel e-Way Bill (Delete record completely)
exports.cancelEwayBill = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    // First, get the e-way bill to check if it exists and get the invoice_id
    const [ewayBillRows] = await db.execute(
      "SELECT * FROM eway_bills WHERE id = ?",
      [id]
    );

    if (ewayBillRows.length === 0) {
      return res.status(404).json({ message: "E-Way Bill not found" });
    }

    const ewayBill = ewayBillRows[0];
    const invoiceId = ewayBill.invoice_id;
    const ewayBillNumber = ewayBill.eway_bill_number;

    // Delete the e-way bill record completely
    const [result] = await db.execute(
      "DELETE FROM eway_bills WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "E-Way Bill not found" });
    }

    // Remove eway_bill_number from the associated invoice
    await db.execute(
      "UPDATE invoices SET eway_bill_number = NULL, updatedAt = NOW() WHERE id = ?",
      [invoiceId]
    );

    // If there's a PDF file, delete it from the filesystem
    if (ewayBill.pdf_file_path) {
      try {
        const filename = ewayBill.pdf_file_path.split('/').pop();
        const uploadsDir = ensureUploadsDir();
        const filePath = path.join(uploadsDir, filename);
        
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`✓ Deleted PDF file: ${filePath}`);
        }
      } catch (fileError) {
        console.error("Error deleting PDF file:", fileError);
        // Continue with the response even if file deletion fails
      }
    }

    res.json({ 
      message: "E-Way Bill cancelled and deleted successfully",
      deleted_eway_bill_number: ewayBillNumber,
      invoice_id: invoiceId
    });
  } catch (err) {
    console.error("Error cancelling e-Way Bill:", err);
    res.status(500).json({ 
      message: "Error cancelling e-Way Bill", 
      error: err.message 
    });
  }
};

// Helper functions
function generateEwayBillNumber() {
  const randomPart = Math.floor(100000000000 + Math.random() * 900000000000);
  return randomPart.toString();
}

async function getHsnCodesFromInvoice(invoiceId) {
  try {
    const [invoiceRows] = await db.execute(
      "SELECT items FROM invoices WHERE id = ?",
      [invoiceId]
    );
    
    if (invoiceRows.length === 0) return ['84186990'];
    
    const items = JSON.parse(invoiceRows[0].items || '[]');
    const hsnCodes = items.map(item => item.hsnCode || item.hsn).filter(Boolean);
    
    return hsnCodes.length > 0 ? hsnCodes : ['84186990'];
  } catch (err) {
    return ['84186990'];
  }
}

exports.createManualEwayBill = async (req, res) => {
  try {
    const { invoice_id, eway_bill_number } = req.body;

    if (!invoice_id || !eway_bill_number) {
      return res.status(400).json({ 
        message: "Invoice ID and E-Way Bill number are required" 
      });
    }

    // Check if invoice exists
    const [invoiceRows] = await db.execute(
      "SELECT * FROM invoices WHERE id = ?",
      [invoice_id]
    );

    if (invoiceRows.length === 0) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const invoice = invoiceRows[0];

    // Check if e-Way Bill number already exists
    const [existingByNumber] = await db.execute(
      "SELECT * FROM eway_bills WHERE eway_bill_number = ?",
      [eway_bill_number]
    );

    if (existingByNumber.length > 0) {
      return res.status(400).json({ 
        message: "E-Way Bill number already exists. Please use a different number."
      });
    }

    // Check if e-Way Bill already exists for this invoice
    const [existingForInvoice] = await db.execute(
      "SELECT * FROM eway_bills WHERE invoice_id = ?",
      [invoice_id]
    );

    if (existingForInvoice.length > 0) {
      return res.status(400).json({ 
        message: "E-Way Bill already exists for this invoice"
      });
    }

    // Get current timestamp for dates
    const currentDate = new Date();
    const validUntil = new Date(currentDate.getTime() + 2 * 24 * 60 * 60 * 1000); // 2 days from now

    // Create manual e-way bill record with all fields
    const [result] = await db.execute(`
      INSERT INTO eway_bills (
        invoice_id, eway_bill_number, eway_bill_date, valid_from, valid_until,
        generated_by_gstin, generated_by_name, supplier_gstin, supplier_name,
        place_of_dispatch, recipient_gstin, recipient_name, place_of_delivery,
        document_number, document_date, transaction_type, value_of_goods, 
        hsn_code, reason_for_transportation, transporter_name, vehicle_number,
        distance_km, mode_of_transport, status, portal_used, pdf_file_path,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `, [
      invoice_id,
      eway_bill_number,
      currentDate, // eway_bill_date
      currentDate, // valid_from
      validUntil, // valid_until
      '33GJXPS2471H1ZJ', // generated_by_gstin
      'Icebergs', // generated_by_name
      '33GJXPS2471H1ZJ', // supplier_gstin
      'Icebergs', // supplier_name
      'Chennai, TAMIL NADU-600096', // place_of_dispatch
      invoice.client_gstin || '', // recipient_gstin
      invoice.client_name || '', // recipient_name
      '', // place_of_delivery (can be empty for manual entry)
      invoice.invoiceNumber, // document_number
      invoice.date, // document_date
      'Regular', // transaction_type
      invoice.total || 0, // value_of_goods
      '', // hsn_code (can be empty)
      'Outward - Supply', // reason_for_transportation
      '', // transporter_name (can be empty)
      '', // vehicle_number (can be empty)
      0, // distance_km
      'Road', // mode_of_transport
      'active', // status
      '1', // portal_used
      null // pdf_file_path (null for manual entry)
    ]);

    // Update invoice with eway_bill_number
    await db.execute(
      "UPDATE invoices SET eway_bill_number = ?, updatedAt = NOW() WHERE id = ?",
      [eway_bill_number, invoice_id]
    );

    // Fetch the created e-Way Bill
    const [ewayBillRows] = await db.execute(
      "SELECT * FROM eway_bills WHERE id = ?",
      [result.insertId]
    );

    res.status(201).json({
      message: "E-Way Bill created successfully with manual entry",
      eway_bill: ewayBillRows[0]
    });

  } catch (err) {
    console.error("Error creating manual e-Way Bill:", err);
    res.status(500).json({ 
      message: "Error creating manual e-Way Bill", 
      error: err.message 
    });
  }
};

function extractCityStateFromAddress(address) {
  if (!address) return 'Chennai, TAMIL NADU-600096';
  const lines = address.split('\n');
  return lines[lines.length - 1] || address;
}