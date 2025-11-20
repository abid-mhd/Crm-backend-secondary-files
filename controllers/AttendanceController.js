const db = require("../config/db");
const { validationResult } = require('express-validator');
const os = require('os');


// Helper function to log attendance actions - RUNS OUTSIDE TRANSACTION
const logAttendanceAction = async (attendanceId, action, details, changes = {}, req = null) => {
  // Run in a separate connection to avoid transaction locks
  setImmediate(async () => {
    try {
      const userName = req?.user?.name || 'System';
      const userId = req?.user?.id || null;
      const ipAddress = req?.ip || req?.connection?.remoteAddress || null;
      const userAgent = req?.get('user-agent') || null;

      await db.execute(
        `INSERT INTO attendance_logs 
         (attendanceId, action, userId, userName, changes, details, ipAddress, userAgent) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attendanceId,
          action,
          userId,
          userName,
          JSON.stringify(changes),
          details,
          ipAddress,
          userAgent
        ]
      );
      
      console.log(`📝 Attendance log created for action: ${action}`);
    } catch (err) {
      console.error("❌ Error logging attendance action:", err);
      // Don't throw - logging should not break the main operation
    }
  });
};

// Log attendance creation
const logAttendanceCreation = async (attendanceId, employeeId, checkType, req = null) => {
  try {
    const [employee] = await db.execute(
      "SELECT employeeName FROM employees WHERE id = ?",
      [employeeId]
    );
    
    const employeeName = employee[0]?.employeeName || 'Unknown';
    
    await logAttendanceAction(
      attendanceId,
      'created',
      `${checkType} recorded for ${employeeName}`,
      {
        employeeId: employeeId,
        employeeName: employeeName,
        checkType: checkType,
        action: 'creation'
      },
      req
    );
  } catch (error) {
    console.error('Error in logAttendanceCreation:', error);
  }
};

// Log attendance deletion
const logAttendanceDeletion = async (attendanceId, req = null) => {
  try {
    const [attendance] = await db.execute(
      `SELECT a.*, e.employeeName 
       FROM attendance a 
       JOIN employees e ON a.employee_id = e.id 
       WHERE a.id = ?`,
      [attendanceId]
    );
    
    if (attendance.length > 0) {
      const record = attendance[0];
      
      await logAttendanceAction(
        attendanceId,
        'deleted',
        `Attendance record deleted for ${record.employeeName} (Date: ${record.date})`,
        {
          employeeId: record.employee_id,
          employeeName: record.employeeName,
          date: record.date,
          status: record.status,
          checkIn: record.check_in,
          checkOut: record.check_out
        },
        req
      );
    }
  } catch (error) {
    console.error('Error in logAttendanceDeletion:', error);
  }
};


function getClientIP(req) {
  try {
    console.log('🔍 Starting enhanced IP detection...');
    
    // Check various headers for real client IP (in order of reliability)
    const ipHeaders = [
      'x-client-ip',
      'x-forwarded-for', 
      'cf-connecting-ip', // Cloudflare
      'true-client-ip',
      'x-real-ip',
      'x-cluster-client-ip',
      'x-forwarded',
      'forwarded-for',
      'forwarded'
    ];

    let clientIP = null;

    // Check headers first
    for (const header of ipHeaders) {
      const headerValue = req.headers[header];
      if (headerValue && headerValue.trim() !== '') {
        clientIP = headerValue.trim();
        console.log(`📡 Found IP in header ${header}:`, clientIP);
        
        // If x-forwarded-for contains multiple IPs, take the first one (client IP)
        if (header === 'x-forwarded-for' && clientIP.includes(',')) {
          clientIP = clientIP.split(',')[0].trim();
          console.log(`📡 Extracted client IP from x-forwarded-for:`, clientIP);
        }
        break;
      }
    }

    // If still no IP found, check connection info
    if (!clientIP) {
      clientIP = req.connection?.remoteAddress || 
                 req.socket?.remoteAddress ||
                 (req.connection?.socket ? req.connection.socket.remoteAddress : null);
      console.log(`📡 Using connection remoteAddress:`, clientIP);
    }

    // Final fallback - get server's network interfaces
    if (!clientIP || clientIP === '::1' || clientIP === '127.0.0.1') {
      console.log('🔄 Localhost detected, checking network interfaces...');
      const networkInterfaces = os.networkInterfaces();
      
      // Find the first non-internal IPv4 address
      for (const interfaceName in networkInterfaces) {
        for (const interface of networkInterfaces[interfaceName]) {
          if (!interface.internal && interface.family === 'IPv4') {
            clientIP = interface.address;
            console.log(`🌐 Using server network interface IP: ${clientIP} from ${interfaceName}`);
            break;
          }
        }
        if (clientIP && clientIP !== '::1' && clientIP !== '127.0.0.1') break;
      }
    }

    // If we still have localhost, try to get external IP
    if (!clientIP || clientIP === '::1' || clientIP === '127.0.0.1') {
      console.log('⚠️ Still localhost, using fallback method...');
      // Try to get the IP from the first network interface
      const networkInterfaces = os.networkInterfaces();
      const eth0 = networkInterfaces['Ethernet'] || networkInterfaces['Wi-Fi'] || networkInterfaces['en0'] || networkInterfaces['eth0'];
      if (eth0 && eth0.length > 0) {
        for (const iface of eth0) {
          if (!iface.internal && iface.family === 'IPv4') {
            clientIP = iface.address;
            console.log(`🔧 Fallback to interface IP: ${clientIP}`);
            break;
          }
        }
      }
    }

    // Final safety check
    if (!clientIP || clientIP === '::1' || clientIP === '127.0.0.1') {
      console.log('❌ Could not determine real LAN IP, using localhost');
      clientIP = '127.0.0.1';
    }

    console.log('✅ Final detected IP:', clientIP);
    return clientIP;
  } catch (error) {
    console.error('❌ Error getting client IP:', error);
    return 'unknown';
  }
}

// Enhanced LAN validation function with Work From Home check
// Modified LAN validation function - ALLOWS ALL REQUESTS
async function validateEmployeeLAN(employeeId, req, isCheckIn = true) {
  try {
    console.log('🔓 LAN VALIDATION DISABLED - Allowing all requests');
    
    // Get employee details for logging
    const [employeeData] = await db.query(
      "SELECT employeeName FROM employees WHERE id = ? AND active = 1",
      [employeeId]
    );

    if (employeeData.length === 0) {
      return {
        allowed: false,
        reason: 'Employee not found or inactive'
      };
    }

    const employee = employeeData[0];
    
    // Check if employee has approved work from home request for today (optional)
    const today = new Date().toISOString().split('T')[0];
    const [workFromHomeRequests] = await db.query(`
      SELECT id, status 
      FROM employee_requests 
      WHERE employee_id = ? 
        AND request_type = 'work_from_home'
        AND DATE(request_date) = DATE(?)
        AND status = 'approved'
    `, [employeeId, today]);

    const hasApprovedWFH = workFromHomeRequests.length > 0;

    console.log('🔓 LAN VALIDATION BYPASSED:', {
      employeeId: employeeId,
      employeeName: employee.employeeName,
      hasApprovedWFH: hasApprovedWFH,
      note: 'LAN restriction is currently disabled'
    });

    // ALWAYS ALLOW - LAN validation disabled
    return {
      allowed: true,
      reason: 'LAN validation disabled - all requests allowed',
      workFromHome: hasApprovedWFH,
      requestId: hasApprovedWFH ? workFromHomeRequests[0].id : null,
      bypass: true
    };

  } catch (error) {
    console.error('❌ Error in LAN validation (bypassed):', error);
    // Even on error, allow the request
    return {
      allowed: true,
      reason: 'LAN validation error - request allowed anyway',
      error: error.message,
      bypass: true
    };
  }
}

// Enhanced mark attendance with comprehensive validation
// exports.markAttendance = async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({ errors: errors.array() });
//     }

//     const { 
//       employeeId, 
//       status, 
//       date, 
//       checkIn, 
//       checkOut, 
//       remarks = '',
//       locationData = null 
//     } = req.body;
    
//     const targetDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

//     console.log('Marking attendance for:', { 
//       employeeId, 
//       status, 
//       targetDate, 
//       checkIn, 
//       checkOut,
//       locationData 
//     });

//     // Enhanced LAN validation for check-in/check-out with WFH check
//     if (checkIn || checkOut) {
//       console.log('🔐 Performing comprehensive LAN/WFH validation...');
//       const isCheckIn = !!checkIn && !checkOut;
//       const lanValidation = await validateEmployeeLAN(employeeId, req, isCheckIn);
      
//       if (!lanValidation.allowed) {
//         console.log('🚫 LAN/WFH validation failed:', lanValidation);
        
//         return res.status(403).json({ 
//           success: false, 
//           message: 'Access denied - LAN validation failed',
//           error: lanValidation.reason,
//           details: lanValidation.details || {},
//           help: lanValidation.details?.help || 'Please ensure you are connected to the office network or have approved Work From Home',
//           debug: {
//             clientIP: getClientIP(req),
//             validationDetails: lanValidation
//           }
//         });
//       } else {
//         if (lanValidation.workFromHome) {
//           console.log('✅ Work From Home approved - LAN validation bypassed');
//         } else {
//           console.log('✅ LAN validation passed:', lanValidation.reason);
//         }
//       }
//     } else {
//       console.log('ℹ️ Skipping LAN validation for status-only update');
//     }

//     // Validate location data structure if provided
//     let locationJson = null;
//     if (locationData) {
//       try {
//         locationJson = JSON.stringify({
//           latitude: locationData.latitude,
//           longitude: locationData.longitude,
//           accuracy: locationData.accuracy,
//           address: locationData.address || null,
//           timestamp: new Date().toISOString(),
//           source: locationData.source || 'browser',
//           ipAddress: getClientIP(req)
//         });
//       } catch (error) {
//         console.error('Error parsing location data:', error);
//         return res.status(400).json({ 
//           success: false, 
//           message: 'Invalid location data format' 
//         });
//       }
//     }

//     // Check if attendance already exists
//     const [existing] = await db.query(
//       "SELECT id, check_in, check_out FROM attendance WHERE employee_id = ? AND DATE(date) = ?",
//       [employeeId, targetDate]
//     );

//     let updateData = { 
//       status, 
//       remarks, 
//       updated_at: new Date() 
//     };
    
//     // Add location data if provided
//     if (locationJson) {
//       updateData.location_data = locationJson;
//     }
    
//     // Add work from home flag if applicable
//     if (lanValidation?.workFromHome) {
//       updateData.work_from_home = true;
//       updateData.work_from_home_request_id = lanValidation.requestId;
//     }
    
//     // Only update check_in if it's provided and not already set
//     if (checkIn && (!existing[0]?.check_in || existing[0]?.check_in === '00:00:00')) {
//       updateData.check_in = checkIn;
//     }
    
//     // Only update check_out if it's provided
//     if (checkOut) {
//       updateData.check_out = checkOut;
//     }

//     if (existing.length > 0) {
//       // Update existing attendance
//       await db.query(
//         `UPDATE attendance 
//          SET ? 
//          WHERE employee_id = ? AND DATE(date) = ?`,
//         [updateData, employeeId, targetDate]
//       );
      
//       console.log('✅ Updated existing attendance record');
//     } else {
//       // Create new attendance record
//       const newData = {
//         employee_id: employeeId,
//         date: targetDate,
//         status: status,
//         remarks: remarks,
//         created_at: new Date(),
//         updated_at: new Date(),
//         ip_address: getClientIP(req), // Store IP address for audit trail
//         work_from_home: lanValidation?.workFromHome || false,
//         work_from_home_request_id: lanValidation?.requestId || null
//       };
      
//       if (checkIn) newData.check_in = checkIn;
//       if (checkOut) newData.check_out = checkOut;
//       if (locationJson) newData.location_data = locationJson;
      
//       await db.query(
//         `INSERT INTO attendance SET ?`,
//         [newData]
//       );
      
//       console.log('✅ Created new attendance record');
//     }

//     // Update employee status in employees table
//     await db.query(
//       `UPDATE employees 
//        SET status = ?, updatedAt = NOW()
//        WHERE id = ?`,
//       [status, employeeId]
//     );

//     console.log('✅ Updated employee status in employees table');

//     res.json({ 
//       success: true, 
//       message: lanValidation?.workFromHome ? 
//         'Attendance marked successfully (Work From Home)' : 
//         'Attendance marked successfully',
//       locationRecorded: !!locationData,
//       workFromHome: lanValidation?.workFromHome || false,
//       ipChecked: true,
//       ipAllowed: true
//     });
//   } catch (error) {
//     console.error('❌ Error marking attendance:', error);
//     res.status(500).json({ 
//       success: false, 
//       message: 'Server error while marking attendance',
//       error: error.message 
//     });
//   }
// };

// Enhanced debug function with WFH information
exports.debugLANValidation = async (req, res) => {
  try {
    const { employeeId } = req.body;
    
    if (!employeeId) {
      return res.status(400).json({
        success: false,
        message: 'Employee ID is required'
      });
    }

    // Get employee details
    const [employeeData] = await db.query(
      "SELECT id, employeeName, meta FROM employees WHERE id = ? AND active = 1",
      [employeeId]
    );

    if (employeeData.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    const employee = employeeData[0];
    let allowedLAN = null;
    let metaData = {};
    
    try {
      metaData = typeof employee.meta === 'string' 
        ? JSON.parse(employee.meta) 
        : employee.meta || {};
      allowedLAN = metaData.lan_no || null;
    } catch (error) {
      console.error('Error parsing meta data:', error);
    }

    // Check for work from home requests
    const today = new Date().toISOString().split('T')[0];
    const [workFromHomeRequests] = await db.query(`
      SELECT id, status, request_date, reason 
      FROM employee_requests 
      WHERE employee_id = ? 
        AND request_type = 'work_from_home'
        AND DATE(request_date) = DATE(?)
    `, [employeeId, today]);

    // Get client IP
    const clientIP = getClientIP(req);
    
    // Get server network interfaces
    const networkInterfaces = os.networkInterfaces();
    const lanIPs = [];
    
    Object.keys(networkInterfaces).forEach(interfaceName => {
      networkInterfaces[interfaceName].forEach(interface => {
        if (!interface.internal && interface.family === 'IPv4') {
          lanIPs.push({
            interface: interfaceName,
            address: interface.address,
            mac: interface.mac,
            internal: interface.internal
          });
        }
      });
    });

    // Test LAN validation
    const lanValidation = await validateEmployeeLAN(employeeId, req);

    const debugInfo = {
      employee: {
        id: employee.id,
        name: employee.employeeName,
        allowedLAN: allowedLAN,
        metaData: metaData,
        hasLANConfigured: !!allowedLAN
      },
      workFromHome: {
        hasRequests: workFromHomeRequests.length > 0,
        requests: workFromHomeRequests,
        hasApprovedWFH: workFromHomeRequests.some(req => req.status === 'approved'),
        today: today
      },
      network: {
        clientIP: clientIP,
        yourLANIPs: lanIPs,
        networkInterfaces: Object.keys(networkInterfaces)
      },
      validation: lanValidation,
      headers: {
        'x-forwarded-for': req.headers['x-forwarded-for'],
        'x-real-ip': req.headers['x-real-ip'],
        'x-client-ip': req.headers['x-client-ip']
      },
      requirements: {
        canCheckIn: lanValidation.allowed,
        requirement: allowedLAN ? 
          `Must match LAN IP: ${allowedLAN} or have approved Work From Home` :
          'Must have approved Work From Home (no LAN IP configured)'
      },
      recommendation: lanIPs.length > 0 ? 
        `Set employee LAN No to: ${lanIPs[0].address}` : 
        'No LAN IPs detected - employee will need Work From Home approval'
    };

    console.log('🔧 ENHANCED LAN DEBUG INFO:', debugInfo);

    res.json({
      success: true,
      data: debugInfo,
      message: 'Enhanced LAN validation debug information'
    });
  } catch (error) {
    console.error('Error in enhanced LAN debug:', error);
    res.status(500).json({
      success: false,
      message: 'Error during LAN debug',
      error: error.message
    });
  }
};

// Check Work From Home status for employee
exports.checkWorkFromHomeStatus = async (req, res) => {
  try {
    const { employeeId, date } = req.query;
    const targetDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    if (!employeeId) {
      return res.status(400).json({
        success: false,
        message: 'Employee ID is required'
      });
    }

    // Check for approved work from home requests
    const [workFromHomeRequests] = await db.query(`
      SELECT 
        er.id,
        er.request_date,
        er.reason,
        er.status,
        er.created_at,
        er.admin_remarks
      FROM employee_requests er
      WHERE er.employee_id = ? 
        AND er.request_type = 'work_from_home'
        AND DATE(er.request_date) = DATE(?)
        AND er.status = 'approved'
    `, [employeeId, targetDate]);

    // Get employee LAN configuration
    const [employeeData] = await db.query(
      "SELECT employeeName, meta FROM employees WHERE id = ?",
      [employeeId]
    );

    let allowedLAN = null;
    if (employeeData.length > 0) {
      try {
        const metaData = typeof employeeData[0].meta === 'string' 
          ? JSON.parse(employeeData[0].meta) 
          : employeeData[0].meta || {};
        allowedLAN = metaData.lan_no || null;
      } catch (error) {
        console.error('Error parsing meta data:', error);
      }
    }

    const hasApprovedWFH = workFromHomeRequests.length > 0;
    const hasLANConfigured = !!allowedLAN;

    res.json({
      success: true,
      data: {
        employeeId: employeeId,
        employeeName: employeeData[0]?.employeeName || 'Unknown',
        date: targetDate,
        workFromHome: {
          approved: hasApprovedWFH,
          requests: workFromHomeRequests
        },
        lanConfiguration: {
          configured: hasLANConfigured,
          allowedLAN: allowedLAN
        },
        accessRequirements: {
          canCheckInWithoutLAN: hasApprovedWFH,
          requiresLAN: !hasApprovedWFH && hasLANConfigured,
          requiresWFHApproval: !hasLANConfigured,
          message: hasApprovedWFH ? 
            'Can check in/out from any location (Work From Home approved)' :
            hasLANConfigured ? 
            'Must be connected to office network with registered LAN IP' :
            'Cannot check in/out - no LAN IP configured and no Work From Home approved'
        }
      }
    });
  } catch (error) {
    console.error('Error checking Work From Home status:', error);
    res.status(500).json({
      success: false,
      message: 'Error checking Work From Home status',
      error: error.message
    });
  }
};

// Get employee's Work From Home history
exports.getWorkFromHomeHistory = async (req, res) => {
  try {
    const { employeeId, month, year } = req.query;
    
    if (!employeeId) {
      return res.status(400).json({
        success: false,
        message: 'Employee ID is required'
      });
    }

    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    const [workFromHomeHistory] = await db.query(`
      SELECT 
        er.id,
        er.request_date,
        er.reason,
        er.status,
        er.admin_remarks,
        er.created_at,
        er.handled_at,
        u.name as handled_by_name
      FROM employee_requests er
      LEFT JOIN users u ON er.handled_by = u.id
      WHERE er.employee_id = ? 
        AND er.request_type = 'work_from_home'
        AND er.request_date BETWEEN ? AND ?
      ORDER BY er.request_date DESC
    `, [employeeId, startDate, endDate]);

    res.json({
      success: true,
      data: workFromHomeHistory,
      count: workFromHomeHistory.length
    });
  } catch (error) {
    console.error('Error fetching Work From Home history:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching Work From Home history',
      error: error.message
    });
  }
};

// Strict IP cleaning function
function cleanIPAddressStrict(ip) {
  if (!ip) return '';
  
  let cleaned = ip.toString().trim();
  
  console.log('🔧 STRICT - Raw IP before cleaning:', cleaned);
  
  // Keep localhost as is (but it will be denied in strict mode)
  if (cleaned === '::1' || cleaned === '127.0.0.1') {
    console.log('🔄 Localhost IP detected (will be denied in strict mode)');
    return cleaned;
  }
  
  // Handle IPv4-mapped IPv6 addresses (::ffff:192.168.1.1)
  if (cleaned.startsWith('::ffff:')) {
    cleaned = cleaned.replace('::ffff:', '');
    console.log('🔄 Converted IPv4-mapped IPv6 to IPv4:', cleaned);
  }
  
  // Remove port number from IPv4 addresses (192.168.1.1:8080 -> 192.168.1.1)
  if (cleaned.includes(':') && cleaned.split(':').length === 2) {
    const parts = cleaned.split(':');
    if (parts[0].includes('.') && parts[1].match(/^\d+$/)) {
      cleaned = parts[0];
      console.log('🔄 Removed port from IPv4:', cleaned);
    }
  }
  
  console.log('🔧 STRICT - Cleaned IP after processing:', cleaned);
  return cleaned;
}

// Helper function to convert IP to integer
function ipToInt(ip) {
  try {
    const parts = ip.split('.');
    
    if (parts.length !== 4) {
      throw new Error(`Invalid IP format: ${ip}`);
    }
    
    const result = (parseInt(parts[0]) << 24) + 
                   (parseInt(parts[1]) << 16) + 
                   (parseInt(parts[2]) << 8) + 
                   parseInt(parts[3]);
    
    // Validate that all parts are numbers
    if (parts.some(part => isNaN(parseInt(part)))) {
      throw new Error(`Invalid IP parts: ${ip}`);
    }
    
    return result >>> 0; // Convert to unsigned 32-bit integer
  } catch (error) {
    console.error('Error converting IP to integer:', error);
    return 0;
  }
}

// Helper function to check if IP is in subnet
function isIPInSubnet(ip, subnet) {
  try {
    const [subnetIP, maskBits] = subnet.split('/');
    const mask = parseInt(maskBits, 10);
    
    // Validate inputs
    if (isNaN(mask) || mask < 0 || mask > 32) {
      console.error('Invalid subnet mask:', maskBits);
      return false;
    }
    
    const ipInt = ipToInt(ip);
    const subnetInt = ipToInt(subnetIP);
    const maskInt = (-1 << (32 - mask)) >>> 0;
    
    const result = (ipInt & maskInt) === (subnetInt & maskInt);
    
    console.log(`🔍 Subnet calculation:`, {
      ip: ip,
      subnet: subnet,
      ipInt: ipInt,
      subnetInt: subnetInt,
      maskInt: maskInt,
      ipNetwork: (ipInt & maskInt),
      subnetNetwork: (subnetInt & maskInt),
      result: result
    });
    
    return result;
  } catch (error) {
    console.error('Error checking subnet:', error);
    return false;
  }
}

// Helper function to check if IP is in range
function isIPInRange(ip, startIP, endIP) {
  try {
    const ipInt = ipToInt(ip);
    const startInt = ipToInt(startIP);
    const endInt = ipToInt(endIP);
    
    const result = ipInt >= startInt && ipInt <= endInt;
    
    console.log(`🔍 Range calculation:`, {
      ip: ip,
      startIP: startIP,
      endIP: endIP,
      ipInt: ipInt,
      startInt: startInt,
      endInt: endInt,
      result: result
    });
    
    return result;
  } catch (error) {
    console.error('Error checking IP range:', error);
    return false;
  }
}

// STRICT IP validation function - NO LOCALHOST BYPASS
function validateIPAgainstLANStrict(clientIP, allowedLAN) {
  const result = {
    isAllowed: false,
    matchType: 'none',
    cleanedClientIP: '',
    cleanedAllowedLAN: '',
    debugInfo: {}
  };

  try {
    // Clean the IP addresses
    result.cleanedClientIP = cleanIPAddressStrict(clientIP);
    result.cleanedAllowedLAN = cleanIPAddressStrict(allowedLAN);
    
    result.debugInfo.rawClientIP = clientIP;
    result.debugInfo.rawAllowedLAN = allowedLAN;
    result.debugInfo.cleanedClientIP = result.cleanedClientIP;
    result.debugInfo.cleanedAllowedLAN = result.cleanedAllowedLAN;

    console.log('🔍 STRICT IP VALIDATION - Cleaning Results:', {
      rawClientIP: clientIP,
      cleanedClientIP: result.cleanedClientIP,
      rawAllowedLAN: allowedLAN,
      cleanedAllowedLAN: result.cleanedAllowedLAN
    });

    // NO LOCALHOST BYPASS - Strict enforcement even in development
    if (result.cleanedClientIP === '127.0.0.1' || result.cleanedClientIP === '::1') {
      console.log('🚫 STRICT MODE: Localhost IP detected but NOT allowed in strict mode');
      result.isAllowed = false;
      result.matchType = 'localhost_strict_denied';
      result.debugInfo.note = 'Localhost access denied in strict mode. Use your real LAN IP.';
      return result;
    }

    // If no LAN restriction is set or empty, DENY access (changed from allow)
    if (!result.cleanedAllowedLAN || result.cleanedAllowedLAN.trim() === '') {
      console.log('🚫 No LAN restriction set - access denied in strict mode');
      result.isAllowed = false;
      result.matchType = 'no_restriction_denied';
      result.debugInfo.note = 'No LAN IP configured. Employee must have Work From Home approval.';
      return result;
    }

    // If cleaned client IP is empty or unknown, deny access
    if (!result.cleanedClientIP || result.cleanedClientIP === 'unknown') {
      console.log('❌ Cannot determine client IP - denying access');
      result.isAllowed = false;
      result.matchType = 'unknown_ip';
      return result;
    }

    // 1. Exact IP match
    if (result.cleanedAllowedLAN === result.cleanedClientIP) {
      console.log('✅ Exact IP match');
      result.isAllowed = true;
      result.matchType = 'exact_match';
      return result;
    }

    // 2. Subnet (CIDR) match
    if (result.cleanedAllowedLAN.includes('/')) {
      const isInSubnet = isIPInSubnet(result.cleanedClientIP, result.cleanedAllowedLAN);
      console.log(`🔍 Subnet check: ${result.cleanedClientIP} in ${result.cleanedAllowedLAN} = ${isInSubnet}`);
      result.debugInfo.subnetCheck = isInSubnet;
      
      if (isInSubnet) {
        result.isAllowed = true;
        result.matchType = 'subnet_match';
        return result;
      }
    }

    // 3. Wildcard pattern match
    if (result.cleanedAllowedLAN.includes('*')) {
      const pattern = result.cleanedAllowedLAN.replace(/\*/g, '.*').replace(/\./g, '\\.');
      const regex = new RegExp(`^${pattern}$`);
      const matches = regex.test(result.cleanedClientIP);
      console.log(`🔍 Wildcard check: ${result.cleanedClientIP} matches ${result.cleanedAllowedLAN} = ${matches}`);
      result.debugInfo.wildcardCheck = matches;
      
      if (matches) {
        result.isAllowed = true;
        result.matchType = 'wildcard_match';
        return result;
      }
    }

    // 4. IP range match
    if (result.cleanedAllowedLAN.includes('-')) {
      const [startIP, endIP] = result.cleanedAllowedLAN.split('-').map(ip => ip.trim());
      const inRange = isIPInRange(result.cleanedClientIP, startIP, endIP);
      console.log(`🔍 Range check: ${result.cleanedClientIP} between ${startIP}-${endIP} = ${inRange}`);
      result.debugInfo.rangeCheck = inRange;
      
      if (inRange) {
        result.isAllowed = true;
        result.matchType = 'range_match';
        return result;
      }
    }

    // 5. Partial match (e.g., "192.168.1" matches "192.168.1.100")
    if (result.cleanedClientIP.startsWith(result.cleanedAllowedLAN)) {
      console.log(`✅ Partial IP match: ${result.cleanedClientIP} starts with ${result.cleanedAllowedLAN}`);
      result.isAllowed = true;
      result.matchType = 'partial_match';
      return result;
    }

    console.log(`❌ No IP match found for ${result.cleanedClientIP} against ${result.cleanedAllowedLAN}`);
    result.isAllowed = false;
    result.matchType = 'no_match';
    result.debugInfo.reason = `IP ${result.cleanedClientIP} does not match allowed pattern ${result.cleanedAllowedLAN}`;
    return result;

  } catch (error) {
    console.error('❌ Error validating IP against LAN:', error);
    result.isAllowed = false;
    result.matchType = 'validation_error';
    result.debugInfo.error = error.message;
    return result;
  }
}

const getEmployeeId = async (req) => {
  console.log('Request user in settings:', req.user);
  if (!req.user || !req.user.id) {
    throw new Error('User not authenticated. Please log in again.');
  }
  
  try {
    const [users] = await db.execute(
      "SELECT employee_id FROM users WHERE id = ?",
      [req.user.id]
    );
    
    if (users.length === 0) {
      throw new Error('User not found in database.');
    }
    
    if (!users[0].employee_id) {
      throw new Error('Employee ID not associated with this user.');
    }
    
    return users[0].employee_id;
  } catch (error) {
    console.error('Error fetching employee ID:', error);
    throw new Error('Error fetching employee information. Please try again.');
  }
};

// Helper function to build SQL SET clause from object
function buildSetClause(data) {
  const keys = Object.keys(data);
  if (keys.length === 0) {
    return { setClause: '', values: [] };
  }
  
  const setClause = keys.map(key => `${key} = ?`).join(', ');
  const values = keys.map(key => data[key]);
  return { setClause, values };
}

// Get all employees
exports.getEmployees = async (req, res) => {
  try {
    const [employees] = await db.query(`
      SELECT 
        id, 
        name, 
        email, 
        phone as mobileNumber,
        department, 
        position, 
        status, 
        check_in as checkIn, 
        check_out as checkOut,
        last_month_due as lastMonthDue,
        balance,
        salary,
        active
      FROM employees 
      WHERE active = 1
    `);
    res.json(employees);
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Get employees with today's attendance
exports.getEmployeesWithAttendance = async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date) : new Date().toISOString().split('T')[0];

    const [employees] = await db.query(`
      SELECT 
        e.id,
        e.name,
        e.phone as mobileNumber,
        e.department,
        e.position,
        e.last_month_due as lastMonthDue,
        e.balance,
        e.salary,
        a.status,
        a.check_in as checkIn,
        a.check_out as checkOut,
        a.overtime_hours as overtimeHours,
        a.overtime_rate as overtimeRate,
        a.overtime_amount as overtimeAmount,
        a.location_data as locationData,
        a.work_from_home as workFromHome
      FROM employees e
      LEFT JOIN attendance a ON e.id = a.employee_id 
        AND DATE(a.date) = ?
      WHERE e.active = 1
      ORDER BY e.name
    `, [targetDate]);

    // Parse location data if it exists
    const employeesWithLocation = employees.map(emp => {
      if (emp.locationData) {
        try {
          emp.locationData = JSON.parse(emp.locationData);
        } catch (e) {
          emp.locationData = null;
        }
      }
      return emp;
    });

    res.json(employeesWithLocation);
  } catch (error) {
    console.error("Error fetching employees with attendance:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Add new employee with LAN configuration
exports.addEmployee = async (req, res) => {
  try {
    const { 
      name, 
      email, 
      phone, 
      department, 
      position, 
      salary,
      last_month_due = 0,
      balance = 0,
      lan_no = null // Added LAN No field
    } = req.body;

    const meta = JSON.stringify({
      addedBy: "system",
      internalNote: "Added via backend",
      timestamp: new Date().toISOString(),
      lan_no: lan_no // Store LAN No in meta
    });

    await db.query(
      `INSERT INTO employees (
        name, email, phone, department, position, salary, 
        last_month_due, balance, meta, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [name, email, phone, department, position, salary, 
       last_month_due, balance, meta]
    );

    res.status(201).json({ 
      message: "Employee added successfully",
      note: lan_no ? 
        `Employee can check in from LAN IP: ${lan_no}` : 
        'Employee will need Work From Home approval to check in'
    });
  } catch (error) {
    console.error("Error adding employee:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Update employee details with LAN configuration
exports.updateEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      name, 
      department, 
      position, 
      phone,
      salary,
      last_month_due,
      balance,
      lan_no = null // Added LAN No field
    } = req.body;

    // Get current meta data to preserve existing settings
    const [employeeData] = await db.query(
      "SELECT meta FROM employees WHERE id = ?",
      [id]
    );

    let meta = {};
    if (employeeData.length > 0) {
      try {
        meta = typeof employeeData[0].meta === 'string' 
          ? JSON.parse(employeeData[0].meta) 
          : employeeData[0].meta || {};
      } catch (error) {
        console.error('Error parsing existing meta data:', error);
      }
    }

    // Update LAN number in meta
    meta.lan_no = lan_no;
    meta.updatedBy = "system";
    meta.timestamp = new Date().toISOString();

    await db.query(
      `UPDATE employees
       SET name=?, department=?, position=?, phone=?, 
           salary=?, last_month_due=?, balance=?, meta=?
       WHERE id=?`,
      [name, department, position, phone, salary, 
       last_month_due, balance, JSON.stringify(meta), id]
    );

    res.json({ 
      message: "Employee updated successfully",
      note: lan_no ? 
        `LAN IP updated to: ${lan_no}` : 
        'LAN IP removed - employee will need Work From Home approval'
    });
  } catch (error) {
    console.error("Error updating employee:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    await db.query("UPDATE employees SET active = 0 WHERE id=?", [id]);
    res.json({ message: "Employee deleted successfully" });
  } catch (error) {
    console.error("Error deleting employee:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// Get attendance summary for a specific date
exports.getAttendanceSummary = async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date) : new Date().toISOString().split('T')[0];

    const [summary] = await db.query(`
      SELECT 
        COUNT(CASE WHEN status = 'Present' THEN 1 END) as present,
        COUNT(CASE WHEN status = 'Absent' THEN 1 END) as absent,
        COUNT(CASE WHEN status = 'Half Day' THEN 1 END) as halfDay,
        COUNT(CASE WHEN status = 'Paid Leave' THEN 1 END) as paidLeave,
        COUNT(CASE WHEN status = 'Weekly Off' THEN 1 END) as weeklyOff,
        COUNT(CASE WHEN work_from_home = 1 THEN 1 END) as workFromHome
      FROM attendance 
      WHERE DATE(date) = ?
    `, [targetDate]);

    const result = {
      present: summary[0]?.present || 0,
      absent: summary[0]?.absent || 0,
      halfDay: summary[0]?.halfDay || 0,
      paidLeave: summary[0]?.paidLeave || 0,
      weeklyOff: summary[0]?.weeklyOff || 0,
      workFromHome: summary[0]?.workFromHome || 0
    };

    res.json(result);
  } catch (error) {
    console.error("Error fetching attendance summary:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.markAttendance = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      await conn.rollback();
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      employeeId, 
      status, 
      date, 
      checkIn, 
      checkOut, 
      remarks = '',
      locationData = null 
    } = req.body;
    
    const targetDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    console.log('🔄 Marking attendance (LAN DISABLED) for:', { 
      employeeId, 
      status, 
      targetDate, 
      checkIn, 
      checkOut,
      locationData 
    });

    // 🚫 SKIP LAN VALIDATION COMPLETELY
    console.log('🔓 LAN VALIDATION DISABLED - Proceeding without IP check');
    
    let lanValidation = {
      allowed: true,
      reason: 'LAN validation disabled',
      bypass: true
    };

    // Rest of your existing markAttendance code remains the same...
    // Validate location data structure if provided
    let locationJson = null;
    if (locationData) {
      try {
        locationJson = JSON.stringify({
          latitude: locationData.latitude,
          longitude: locationData.longitude,
          accuracy: locationData.accuracy,
          address: locationData.address || null,
          timestamp: new Date().toISOString(),
          source: locationData.source || 'browser',
          ipAddress: getClientIP(req)
        });
      } catch (error) {
        console.error('Error parsing location data:', error);
        await conn.rollback();
        return res.status(400).json({ 
          success: false, 
          message: 'Invalid location data format' 
        });
      }
    }

    // Check if attendance already exists
    const [existing] = await conn.execute(
      "SELECT id, check_in, check_out FROM attendance WHERE employee_id = ? AND DATE(date) = ?",
      [employeeId, targetDate]
    );

    let updateData = { 
      status, 
      remarks, 
      updated_at: new Date() 
    };
    
    // Add location data if provided
    if (locationJson) {
      updateData.location_data = locationJson;
    }
    
    // Only update check_in if it's provided and not already set
    if (checkIn && (!existing[0]?.check_in || existing[0]?.check_in === '00:00:00')) {
      updateData.check_in = checkIn;
    }
    
    // Only update check_out if it's provided
    if (checkOut) {
      updateData.check_out = checkOut;
    }

    let attendanceId;
    let actionType = 'updated';
    let logDetails = '';

    if (existing.length > 0) {
      // Update existing attendance
      attendanceId = existing[0].id;
      
      // Build SET clause for UPDATE
      const { setClause, values } = buildSetClause(updateData);
      const updateQuery = `UPDATE attendance SET ${setClause} WHERE employee_id = ? AND DATE(date) = ?`;
      
      await conn.execute(updateQuery, [...values, employeeId, targetDate]);
      
      console.log('✅ Updated existing attendance record');
      actionType = 'checked_' + (checkIn ? 'in' : checkOut ? 'out' : 'updated');
      logDetails = `Attendance ${checkIn ? 'check-in' : checkOut ? 'check-out' : 'updated'} for employee ${employeeId}`;
    } else {
      // Create new attendance record
      const newData = {
        employee_id: employeeId,
        date: targetDate,
        status: status,
        remarks: remarks,
        created_at: new Date(),
        updated_at: new Date(),
        ip_address: getClientIP(req)
      };
      
      if (checkIn) newData.check_in = checkIn;
      if (checkOut) newData.check_out = checkOut;
      if (locationJson) newData.location_data = locationJson;
      
      // Build INSERT query
      const keys = Object.keys(newData);
      const placeholders = keys.map(() => '?').join(', ');
      const insertQuery = `INSERT INTO attendance (${keys.join(', ')}) VALUES (${placeholders})`;
      const values = keys.map(key => newData[key]);
      
      const [result] = await conn.execute(insertQuery, values);
      
      attendanceId = result.insertId;
      console.log('✅ Created new attendance record');
      actionType = 'created';
      logDetails = `New attendance record created for employee ${employeeId}`;
    }

    // Update employee status in employees table
    await conn.execute(
      `UPDATE employees 
       SET status = ?, updatedAt = NOW()
       WHERE id = ?`,
      [status, employeeId]
    );

    console.log('✅ Updated employee status in employees table');

    // Commit transaction FIRST
    await conn.commit();

    // THEN log the action OUTSIDE the transaction
    const [employee] = await db.execute(
      "SELECT employeeName FROM employees WHERE id = ?",
      [employeeId]
    );
    
    const employeeName = employee[0]?.employeeName || 'Unknown';

    const changes = {
      employeeId: employeeId,
      employeeName: employeeName,
      date: targetDate,
      status: status,
      checkIn: checkIn || null,
      checkOut: checkOut || null,
      locationRecorded: !!locationData,
      lanBypassed: true
    };

    await logAttendanceAction(
      attendanceId,
      actionType,
      `${employeeName} - ${logDetails} (LAN validation disabled)`,
      changes,
      req
    );

    res.json({ 
      success: true, 
      message: 'Attendance marked successfully (LAN validation disabled)',
      locationRecorded: !!locationData,
      workFromHome: false,
      ipChecked: false,
      ipAllowed: true,
      lanBypassed: true,
      attendanceId: attendanceId
    });
  } catch (error) {
    await conn.rollback();
    console.error('❌ Error marking attendance:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while marking attendance',
      error: error.message 
    });
  } finally {
    conn.release();
  }
};



exports.debugLANValidation = async (req, res) => {
  try {
    const { employeeId } = req.body;
    
    if (!employeeId) {
      return res.status(400).json({
        success: false,
        message: 'Employee ID is required'
      });
    }

    // Get employee details
    const [employeeData] = await db.query(
      "SELECT id, employeeName, meta FROM employees WHERE id = ? AND active = 1",
      [employeeId]
    );

    if (employeeData.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    const employee = employeeData[0];
    let allowedLAN = null;
    let metaData = {};
    
    try {
      metaData = typeof employee.meta === 'string' 
        ? JSON.parse(employee.meta) 
        : employee.meta || {};
      allowedLAN = metaData.lan_no || null;
    } catch (error) {
      console.error('Error parsing meta data:', error);
    }

    // Get client IP
    const clientIP = getClientIP(req);
    
    // Get server network interfaces
    const networkInterfaces = os.networkInterfaces();
    const lanIPs = [];
    
    Object.keys(networkInterfaces).forEach(interfaceName => {
      networkInterfaces[interfaceName].forEach(interface => {
        if (!interface.internal && interface.family === 'IPv4') {
          lanIPs.push({
            interface: interfaceName,
            address: interface.address,
            mac: interface.mac,
            internal: interface.internal
          });
        }
      });
    });

    // Test LAN validation
    const lanValidation = await validateEmployeeLAN(employeeId, req);

    const debugInfo = {
      employee: {
        id: employee.id,
        name: employee.employeeName,
        allowedLAN: allowedLAN,
        metaData: metaData
      },
      network: {
        clientIP: clientIP,
        yourLANIPs: lanIPs,
        networkInterfaces: Object.keys(networkInterfaces)
      },
      validation: lanValidation,
      headers: {
        'x-forwarded-for': req.headers['x-forwarded-for'],
        'x-real-ip': req.headers['x-real-ip'],
        'x-client-ip': req.headers['x-client-ip']
      },
      recommendation: lanIPs.length > 0 ? 
        `Set employee LAN No to: ${lanIPs[0].address}` : 
        'No LAN IPs detected'
    };

    console.log('🔧 LAN DEBUG INFO:', debugInfo);

    res.json({
      success: true,
      data: debugInfo,
      message: 'LAN validation debug information'
    });
  } catch (error) {
    console.error('Error in LAN debug:', error);
    res.status(500).json({
      success: false,
      message: 'Error during LAN debug',
      error: error.message
    });
  }
};

// Get your actual LAN IP
exports.getMyLANIP = async (req, res) => {
  try {
    const clientIP = getClientIP(req);
    
    // Get network interfaces
    const networkInterfaces = os.networkInterfaces();
    const lanIPs = [];
    
    Object.keys(networkInterfaces).forEach(interfaceName => {
      networkInterfaces[interfaceName].forEach(interface => {
        // Skip internal and non-IPv4 addresses
        if (!interface.internal && interface.family === 'IPv4') {
          lanIPs.push({
            interface: interfaceName,
            address: interface.address,
            mac: interface.mac,
            internal: interface.internal
          });
        }
      });
    });
    
    const networkInfo = {
      clientIP: clientIP,
      yourLANIPs: lanIPs,
      recommendedIP: lanIPs.length > 0 ? lanIPs[0].address : 'No LAN IP found',
      serverNetworkInfo: Object.keys(networkInterfaces),
      headers: {
        'x-forwarded-for': req.headers['x-forwarded-for'],
        'x-real-ip': req.headers['x-real-ip'],
        'x-client-ip': req.headers['x-client-ip']
      },
      timestamp: new Date().toISOString(),
      note: 'Use the recommended IP in the employee LAN No field'
    };

    console.log('🌐 YOUR LAN IPs:', lanIPs);
    console.log('🌐 CLIENT IP DETECTED:', clientIP);
    console.log('🌐 RECOMMENDED IP:', networkInfo.recommendedIP);

    res.json({
      success: true,
      data: networkInfo,
      message: 'Your LAN IP information retrieved successfully'
    });
  } catch (error) {
    console.error('Error getting LAN IP:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get LAN IP information'
    });
  }
};

// Test your actual IP against an allowed LAN
exports.testMyIP = async (req, res) => {
  try {
    const { allowedLAN } = req.body;
    const clientIP = getClientIP(req);
    
    const validationResult = validateIPAgainstLANStrict(clientIP, allowedLAN);
    
    const networkInterfaces = os.networkInterfaces();
    const lanIPs = [];
    
    Object.keys(networkInterfaces).forEach(interfaceName => {
      networkInterfaces[interfaceName].forEach(interface => {
        if (!interface.internal && interface.family === 'IPv4') {
          lanIPs.push(interface.address);
        }
      });
    });

    console.log('🧪 MY IP TEST:', {
      clientIP: clientIP,
      allowedLAN: allowedLAN,
      result: validationResult,
      myLANIPs: lanIPs
    });

    res.json({
      success: true,
      data: {
        yourClientIP: clientIP,
        yourLANIPs: lanIPs,
        allowedLAN: allowedLAN,
        validationResult: validationResult,
        recommendation: lanIPs.length > 0 ? 
          `Set employee LAN No to: ${lanIPs[0]}` : 
          'Cannot detect your LAN IP'
      }
    });
  } catch (error) {
    console.error('Error testing my IP:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test IP'
    });
  }
};

// Get network information
exports.getNetworkInfo = async (req, res) => {
  try {
    const clientIP = getClientIP(req);
    const networkInfo = {
      clientIP: clientIP,
      headers: {
        'x-forwarded-for': req.headers['x-forwarded-for'],
        'x-real-ip': req.headers['x-real-ip'],
        'x-client-ip': req.headers['x-client-ip'],
        'cf-connecting-ip': req.headers['cf-connecting-ip'],
        'true-client-ip': req.headers['true-client-ip']
      },
      connection: {
        remoteAddress: req.connection?.remoteAddress,
        socketRemoteAddress: req.socket?.remoteAddress
      },
      timestamp: new Date().toISOString(),
      userAgent: req.headers['user-agent']
    };

    console.log('🌐 NETWORK INFO REQUEST:', networkInfo);

    res.json({
      success: true,
      data: networkInfo,
      message: 'Network information retrieved successfully'
    });
  } catch (error) {
    console.error('Error getting network info:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get network information'
    });
  }
};

// Test IP matching endpoint
exports.testIPMatch = async (req, res) => {
  try {
    const { testIP, allowedLAN } = req.body;
    
    const clientIP = testIP || getClientIP(req);
    const validationResult = validateIPAgainstLANStrict(clientIP, allowedLAN);
    
    console.log('🧪 IP MATCH TEST:', {
      testIP: testIP,
      allowedLAN: allowedLAN,
      result: validationResult
    });

    res.json({
      success: true,
      data: {
        testIP: testIP,
        allowedLAN: allowedLAN,
        validationResult: validationResult,
        networkInfo: {
          clientIP: getClientIP(req),
          headers: req.headers
        }
      }
    });
  } catch (error) {
    console.error('Error testing IP match:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test IP matching'
    });
  }
};

// Update employee LAN IP
exports.updateEmployeeLAN = async (req, res) => {
  try {
    const { employeeId, lanNo } = req.body;
    
    // Get current meta data
    const [employeeData] = await db.query(
      "SELECT meta FROM employees WHERE id = ?",
      [employeeId]
    );

    if (employeeData.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Employee not found' 
      });
    }

    let meta = {};
    try {
      meta = typeof employeeData[0].meta === 'string' 
        ? JSON.parse(employeeData[0].meta) 
        : employeeData[0].meta || {};
    } catch (error) {
      console.error('Error parsing meta data:', error);
    }

    // Update LAN number
    meta.lan_no = lanNo;
    meta.lan_updated_at = new Date().toISOString();

    // Save updated meta
    await db.query(
      "UPDATE employees SET meta = ? WHERE id = ?",
      [JSON.stringify(meta), employeeId]
    );

    res.json({ 
      success: true, 
      message: 'Employee LAN IP updated successfully',
      data: { lanNo }
    });
  } catch (error) {
    console.error('Error updating employee LAN IP:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while updating LAN IP' 
    });
  }
};

// Get employee LAN info
exports.getEmployeeLANInfo = async (req, res) => {
  try {
    const { employeeId } = req.params;
    
    const [employeeData] = await db.query(
      "SELECT id, employeeName, meta FROM employees WHERE id = ?",
      [employeeId]
    );

    if (employeeData.length === 0) {
      return res.status(404).json({ 
        success: false, 
        message: 'Employee not found' 
      });
    }

    let lanInfo = {};
    try {
      const meta = typeof employeeData[0].meta === 'string' 
        ? JSON.parse(employeeData[0].meta) 
        : employeeData[0].meta || {};
      
      lanInfo = {
        employeeId: employeeData[0].id,
        employeeName: employeeData[0].employeeName,
        allowedLAN: meta.lan_no || 'Not set',
        lastUpdated: meta.lan_updated_at || null
      };
    } catch (error) {
      console.error('Error parsing meta data:', error);
    }

    res.json({ 
      success: true, 
      data: lanInfo 
    });
  } catch (error) {
    console.error('Error fetching employee LAN info:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching LAN info' 
    });
  }
};

// Add overtime with location (optional)
exports.addOvertime = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      employeeId, 
      hours, 
      rate, 
      type, 
      amount, 
      date, 
      calculationType,
      locationData = null 
    } = req.body;
    
    const targetDate = date ? new Date(date) : new Date().toISOString().split('T')[0];

    // Convert rate from string with commas to decimal
    const cleanRate = parseFloat(rate.replace(/,/g, ''));
    const cleanAmount = parseFloat(amount.toString().replace(/,/g, ''));

    // Prepare location data if provided
    let locationJson = null;
    if (locationData) {
      try {
        locationJson = JSON.stringify({
          latitude: locationData.latitude,
          longitude: locationData.longitude,
          accuracy: locationData.accuracy,
          address: locationData.address || null,
          timestamp: new Date().toISOString(),
          source: locationData.source || 'browser'
        });
      } catch (error) {
        console.error('Error parsing location data for overtime:', error);
      }
    }

    // Check if attendance record exists
    const [existing] = await db.query(
      "SELECT id FROM attendance WHERE employee_id = ? AND DATE(date) = ?",
      [employeeId, targetDate]
    );

    if (existing.length > 0) {
      // Update existing record with overtime
      const updateData = {
        overtime_hours: hours,
        overtime_rate: cleanRate,
        overtime_type: type,
        overtime_amount: cleanAmount,
        overtime_calculation_type: calculationType,
        updated_at: new Date()
      };

      // Add location data if provided
      if (locationJson) {
        updateData.location_data = locationJson;
      }

      await db.query(
        `UPDATE attendance 
         SET ?
         WHERE employee_id = ? AND DATE(date) = ?`,
        [updateData, employeeId, targetDate]
      );
    } else {
      // Create new record with overtime
      const newData = {
        employee_id: employeeId,
        date: targetDate,
        status: 'Present',
        overtime_hours: hours,
        overtime_rate: cleanRate,
        overtime_type: type,
        overtime_amount: cleanAmount,
        overtime_calculation_type: calculationType,
        created_at: new Date(),
        updated_at: new Date()
      };

      // Add location data if provided
      if (locationJson) {
        newData.location_data = locationJson;
      }

      await db.query(
        `INSERT INTO attendance SET ?`,
        [newData]
      );
    }

    res.json({ 
      success: true, 
      message: 'Overtime added successfully',
      locationRecorded: !!locationData 
    });
  } catch (error) {
    console.error('Error adding overtime:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get attendance history for an employee with location data
exports.getAttendanceHistory = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { month, year } = req.query;

    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    const [history] = await db.query(`
      SELECT 
        id,
        date,
        status,
        check_in as checkIn,
        check_out as checkOut,
        overtime_hours as overtimeHours,
        overtime_amount as overtimeAmount,
        remarks,
        location_data as locationData
      FROM attendance 
      WHERE employee_id = ? 
        AND date BETWEEN ? AND ?
      ORDER BY date DESC
    `, [employeeId, startDate, endDate]);

    // Parse location data for each record
    const historyWithLocation = history.map(record => {
      if (record.locationData) {
        try {
          record.locationData = JSON.parse(record.locationData);
        } catch (e) {
          record.locationData = null;
        }
      }
      return record;
    });

    res.json({ success: true, data: historyWithLocation });
  } catch (error) {
    console.error('Error fetching attendance history:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Update attendance with location
exports.updateAttendance = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const { id } = req.params;
    const { 
      status, 
      checkIn, 
      checkOut, 
      overtimeHours, 
      remarks, 
      date,
      locationData = null 
    } = req.body;

    console.log('🔄 Updating attendance:', { 
      id, 
      status, 
      checkIn, 
      checkOut, 
      overtimeHours, 
      remarks,
      locationData 
    });

    // Get existing attendance record for comparison
    const [existingRecords] = await conn.execute(
      `SELECT 
        a.*,
        e.employeeName,
        e.department
      FROM attendance a
      JOIN employees e ON a.employee_id = e.id
      WHERE a.id = ?`,
      [id]
    );

    if (existingRecords.length === 0) {
      await conn.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Attendance record not found' 
      });
    }

    const existingRecord = existingRecords[0];
    
    // Track changes for logging
    const changes = {};

    // Check status changes
    if (status && existingRecord.status !== status) {
      changes.status = { 
        from: existingRecord.status, 
        to: status 
      };
    }

    // Check check-in changes
    if (checkIn && existingRecord.check_in !== checkIn) {
      changes.check_in = { 
        from: existingRecord.check_in, 
        to: checkIn 
      };
    }

    // Check check-out changes
    if (checkOut && existingRecord.check_out !== checkOut) {
      changes.check_out = { 
        from: existingRecord.check_out || 'Not set', 
        to: checkOut 
      };
    }

    // Check overtime hours changes
    if (overtimeHours !== undefined && parseFloat(existingRecord.overtime_hours) !== parseFloat(overtimeHours)) {
      changes.overtime_hours = { 
        from: existingRecord.overtime_hours || 0, 
        to: overtimeHours 
      };
    }

    // Check remarks changes
    if (remarks !== undefined && existingRecord.remarks !== remarks) {
      changes.remarks = { 
        from: existingRecord.remarks || 'No remarks', 
        to: remarks 
      };
    }

    // Check location data changes
    if (locationData) {
      changes.location_data = { 
        from: 'Previous location data', 
        to: 'Updated location data' 
      };
    }

    // Prepare location data if provided
    let locationJson = null;
    if (locationData) {
      try {
        locationJson = JSON.stringify({
          latitude: locationData.latitude,
          longitude: locationData.longitude,
          accuracy: locationData.accuracy,
          address: locationData.address || null,
          timestamp: new Date().toISOString(),
          source: locationData.source || 'manual_update',
          updatedBy: req.user?.name || 'System',
          updateType: 'manual'
        });
      } catch (error) {
        console.error('Error parsing location data for update:', error);
      }
    }

    // Build update object with only provided fields
    const updateFields = {
      updated_at: new Date()
    };

    if (status) updateFields.status = status;
    if (checkIn) updateFields.check_in = checkIn;
    if (checkOut) updateFields.check_out = checkOut;
    if (overtimeHours !== undefined) updateFields.overtime_hours = overtimeHours;
    if (remarks !== undefined) updateFields.remarks = remarks;
    if (locationJson) updateFields.location_data = locationJson;

    // Build SET clause for UPDATE
    const { setClause, values } = buildSetClause(updateFields);
    const updateQuery = `UPDATE attendance SET ${setClause} WHERE id = ?`;
    
    // Perform the update
    await conn.execute(updateQuery, [...values, id]);

    // Commit transaction FIRST
    await conn.commit();

    // THEN log the action OUTSIDE the transaction
    let actionType = 'updated';
    let details = `Attendance record updated for ${existingRecord.employeeName}`;
    
    if (Object.keys(changes).length > 0) {
      const changeList = Object.keys(changes).map(key => {
        if (key === 'status') {
          return `status changed from "${changes[key].from}" to "${changes[key].to}"`;
        } else if (key === 'check_in') {
          return `check-in time changed from "${changes[key].from}" to "${changes[key].to}"`;
        } else if (key === 'check_out') {
          return `check-out time changed from "${changes[key].from}" to "${changes[key].to}"`;
        } else if (key === 'overtime_hours') {
          return `overtime hours changed from ${changes[key].from} to ${changes[key].to}`;
        } else if (key === 'remarks') {
          return 'remarks updated';
        } else if (key === 'location_data') {
          return 'location data updated';
        }
        return `${key} updated`;
      }).join(', ');
      
      details += ` - ${changeList}`;
    } else {
      details += ' - No significant changes detected';
      actionType = 'viewed';
    }

    // Log the attendance update
    await logAttendanceAction(
      parseInt(id),
      actionType,
      details,
      changes,
      req
    );

    console.log('✅ Attendance updated successfully with logging');

    res.json({ 
      success: true, 
      message: 'Attendance updated successfully',
      locationUpdated: !!locationData,
      changes: Object.keys(changes).length > 0 ? changes : null
    });
  } catch (error) {
    await conn.rollback();
    console.error('❌ Error updating attendance:', error);
    
    // Log the error
    await logAttendanceAction(
      parseInt(req.params.id),
      'update_failed',
      `Failed to update attendance record: ${error.message}`,
      { error: error.message },
      req
    );

    res.status(500).json({ 
      success: false, 
      message: 'Server error while updating attendance',
      error: error.message 
    });
  } finally {
    conn.release();
  }
};

// Delete attendance record with logging
exports.deleteAttendance = async (req, res) => {
  const conn = await db.getConnection();
  
  try {
    await conn.beginTransaction();

    const { id } = req.params;

    console.log('🗑️ Deleting attendance record:', id);

    // Get attendance record before deletion for logging
    const [existingRecords] = await conn.execute(
      `SELECT a.*, e.employeeName 
       FROM attendance a 
       JOIN employees e ON a.employee_id = e.id 
       WHERE a.id = ?`,
      [id]
    );

    if (existingRecords.length === 0) {
      await conn.rollback();
      return res.status(404).json({ 
        success: false, 
        message: 'Attendance record not found' 
      });
    }

    const existingRecord = existingRecords[0];

    // Delete the attendance record
    await conn.execute('DELETE FROM attendance WHERE id = ?', [id]);

    // Commit transaction FIRST
    await conn.commit();

    // THEN log the deletion OUTSIDE the transaction
    await logAttendanceDeletion(id, req);

    console.log('✅ Attendance record deleted successfully with logging');

    res.json({ 
      success: true, 
      message: 'Attendance record deleted successfully',
      deletedRecord: {
        id: id,
        employeeName: existingRecord.employeeName,
        date: existingRecord.date,
        status: existingRecord.status
      }
    });
  } catch (error) {
    await conn.rollback();
    console.error('❌ Error deleting attendance:', error);
    
    // Log the error
    await logAttendanceAction(
      parseInt(id),
      'delete_failed',
      `Failed to delete attendance record: ${error.message}`,
      { error: error.message },
      req
    );

    res.status(500).json({ 
      success: false, 
      message: 'Server error while deleting attendance',
      error: error.message 
    });
  } finally {
    conn.release();
  }
};

// Today's attendance with location data
exports.todayAttendance = async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    console.log('Fetching today attendance for date:', targetDate);

    const [attendance] = await db.query(`
      SELECT 
        a.id as attendance_id,
        a.employee_id,
        a.status,
        a.check_in,
        a.check_out,
        a.overtime_hours,
        a.remarks,
        a.location_data as locationData,
        a.date as attendance_date,
        e.id as employee_id,
        e.employeeName as employee_name,
        e.department,
        e.position,
        e.phone,
        e.balance,
        e.last_month_due
      FROM attendance a
      JOIN employees e ON a.employee_id = e.id
      WHERE DATE(a.date) = ?
      ORDER BY e.employeeName
    `, [targetDate]);

    // Don't parse location data here - let frontend handle it
    // Just return the raw data as is
    console.log(`Found ${attendance.length} attendance records for ${targetDate}`);

    // Debug: Check first record's location data
    if (attendance.length > 0) {
      console.log('First record location data type:', typeof attendance[0].locationData);
      console.log('First record location data:', attendance[0].locationData);
    }

    res.json({ 
      success: true, 
      data: attendance, // Return raw data without parsing
      count: attendance.length,
      date: targetDate
    });
  } catch (error) {
    console.error('Error fetching today attendance:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching today attendance',
      error: error.message 
    });
  }
};

// Get my attendance with location data
exports.getMyAttendance = async (req, res) => {
  try {
    const { month, year } = req.query;
    const employeeId = await getEmployeeId(req);

    if (!employeeId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Employee ID not found' 
      });
    }

    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    console.log('Fetching my attendance for:', { employeeId, startDate, endDate });

    const [attendance] = await db.query(`
      SELECT 
        id,
        date,
        status,
        check_in as checkIn,
        check_out as checkOut,
        overtime_hours as overtimeHours,
        overtime_amount as overtimeAmount,
        remarks,
        location_data as locationData
      FROM attendance 
      WHERE employee_id = ? 
        AND date BETWEEN ? AND ?
      ORDER BY date DESC
    `, [employeeId, startDate, endDate]);

    // Parse location data for each record
    const attendanceWithLocation = attendance.map(record => {
      if (record.locationData) {
        try {
          record.locationData = JSON.parse(record.locationData);
        } catch (e) {
          record.locationData = null;
        }
      }
      return record;
    });

    res.json({
      success: true,
      data: attendanceWithLocation,
      count: attendance.length
    });
  } catch (error) {
    console.error('Get my attendance error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching attendance' 
    });
  }
};

// Get attendance by location (for reporting/analytics)
exports.getAttendanceByLocation = async (req, res) => {
  try {
    const { date, latitude, longitude, radius = 1000 } = req.query; // radius in meters
    
    const targetDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

    // Get all attendance for the date
    const [attendance] = await db.query(`
      SELECT 
        a.id,
        a.employee_id,
        a.status,
        a.check_in,
        a.check_out,
        a.location_data,
        e.name as employee_name,
        e.department
      FROM attendance a
      JOIN employees e ON a.employee_id = e.id
      WHERE DATE(a.date) = ?
        AND a.location_data IS NOT NULL
    `, [targetDate]);

    // Filter by proximity if coordinates provided
    let filteredAttendance = attendance;
    if (latitude && longitude) {
      filteredAttendance = attendance.filter(record => {
        try {
          const location = JSON.parse(record.location_data);
          if (location.latitude && location.longitude) {
            const distance = calculateDistance(
              parseFloat(latitude),
              parseFloat(longitude),
              parseFloat(location.latitude),
              parseFloat(location.longitude)
            );
            return distance <= (radius / 1000); // Convert to kilometers
          }
        } catch (e) {
          return false;
        }
        return false;
      });
    }

    // Parse location data
    const attendanceWithLocation = filteredAttendance.map(record => {
      if (record.location_data) {
        try {
          record.location_data = JSON.parse(record.location_data);
        } catch (e) {
          record.location_data = null;
        }
      }
      return record;
    });

    res.json({
      success: true,
      data: attendanceWithLocation,
      count: attendanceWithLocation.length
    });
  } catch (error) {
    console.error('Error fetching attendance by location:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching attendance by location' 
    });
  }
};

// Helper function to calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c; // Distance in kilometers
  return distance;
}

exports.getAttendanceSettings = async (req, res) => {
  try {
    const [settings] = await db.query(`
      SELECT * FROM attendance_settings 
      ORDER BY created_at DESC, id DESC 
      LIMIT 1
    `);
    
    // Check if any settings exist
    if (settings && settings.length > 0) {
      try {
        const latestSetting = settings[0];
        
        // Parse the settings_data if it's a JSON string
        const settingsData = typeof latestSetting.settings_data === 'string' 
          ? JSON.parse(latestSetting.settings_data)
          : latestSetting.settings_data;
        
        res.json({
          ...settingsData,
          // Include metadata if needed
          id: latestSetting.id,
          created_at: latestSetting.created_at,
          updated_at: latestSetting.updated_at
        });
      } catch (parseError) {
        console.error('Error parsing settings data:', parseError);
        // Return default settings if parsing fails
        returnDefaultSettings(res);
      }
    } else {
      // Return default settings if no settings found
      returnDefaultSettings(res);
    }
  } catch (error) {
    console.error('Error fetching attendance settings:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

// Helper function to return default settings
function returnDefaultSettings(res) {
  const defaultSettings = {
    enableDailyReminder: false,
    reminderTime: '08:55',
    markPresentByDefault: false,
    workingHours: '09:00',
    weeklyOff: {
      sun: true, 
      mon: false, 
      tue: false, 
      wed: false, 
      thu: false, 
      fri: false, 
      sat: false
    }
  };
  res.json(defaultSettings);
}

exports.saveAttendanceSettings = async (req, res) => {
  try {
    const settings = req.body;
    
    // Check if settings already exist
    const [existing] = await db.query(`
      SELECT * FROM attendance_settings WHERE id = 1
    `);
    
    if (existing && existing.length > 0) {
      // Update existing settings
      await db.query(`
        UPDATE attendance_settings 
        SET settings_data = ?, updated_at = NOW() 
        WHERE id = 1
      `, [JSON.stringify(settings)]);
    } else {
      // Insert new settings
      await db.query(`
        INSERT INTO attendance_settings (id, settings_data, created_at, updated_at)
        VALUES (1, ?, NOW(), NOW())
      `, [JSON.stringify(settings)]);
    }
    
    res.json({ message: 'Settings saved successfully' });
  } catch (error) {
    console.error('Error saving attendance settings:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};

exports.saveAttendanceSettings = async (req, res) => {
  try {
    const settings = req.body;
    
    const [existing] = await db.query(`
      SELECT id FROM attendance_settings WHERE id = 1
    `);

    if (existing.length > 0) {
      // Update existing settings
      await db.query(`
        UPDATE attendance_settings 
        SET settings_data = ?, updated_at = NOW()
        WHERE id = 1
      `, [JSON.stringify(settings)]);
    } else {
      // Insert new settings
      await db.query(`
        INSERT INTO attendance_settings (id, settings_data, created_at, updated_at)
        VALUES (1, ?, NOW(), NOW())
      `, [JSON.stringify(settings)]);
    }

    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (error) {
    console.error('Error saving attendance settings:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get employee details with extended information
exports.getEmployeeDetails = async (req, res) => {
  try {
    const { id } = req.params;
    
    const [employee] = await db.query(`
      SELECT 
        e.*,
        COALESCE(SUM(a.overtime_amount), 0) as total_overtime,
        COUNT(a.id) as total_attendance_records
      FROM employees e
      LEFT JOIN attendance a ON e.id = a.employee_id
      WHERE e.id = ?
      GROUP BY e.id
    `, [id]);

    if (employee.length === 0) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    res.json({ success: true, data: employee[0] });
  } catch (error) {
    console.error('Error fetching employee details:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Get employee payroll summary
exports.getEmployeePayroll = async (req, res) => {
  try {
    const { employeeId, month, year } = req.query;
    
    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    // Get attendance summary with overtime
    const [attendanceSummary] = await db.query(`
      SELECT 
        COUNT(CASE WHEN status = 'Present' THEN 1 END) as present_days,
        COUNT(CASE WHEN status = 'Absent' THEN 1 END) as absent_days,
        COUNT(CASE WHEN status = 'Half Day' THEN 1 END) as half_days,
        COUNT(CASE WHEN status = 'Paid Leave' THEN 1 END) as paid_leaves,
        COUNT(CASE WHEN status = 'Weekly Off' THEN 1 END) as weekly_off,
        COUNT(CASE WHEN overtime_amount > 0 THEN 1 END) as overtime_days,
        COALESCE(SUM(overtime_amount), 0) as total_overtime,
        COALESCE(SUM(overtime_hours), 0) as total_overtime_hours,
        COALESCE(AVG(overtime_rate), 0) as avg_overtime_rate
      FROM attendance 
      WHERE employee_id = ? 
        AND date BETWEEN ? AND ?
    `, [employeeId, startDate, endDate]);

    // Get employee basic salary and details
    const [employeeData] = await db.query(`
      SELECT 
        salary,
        last_month_due,
        balance
      FROM employees 
      WHERE id = ?
    `, [employeeId]);

    let salaryData = {};
    try {
      salaryData = typeof employeeData[0]?.salary === 'string' 
        ? JSON.parse(employeeData[0].salary) 
        : employeeData[0]?.salary || {};
    } catch (e) {
      salaryData = {};
    }

    const result = {
      ...attendanceSummary[0],
      basic_salary: salaryData.basicSalary || 0,
      allowances: salaryData.otherAllowances || 0,
      deductions: salaryData.totalDeductions || 0,
      last_month_due: employeeData[0]?.last_month_due || 0,
      current_balance: employeeData[0]?.balance || 0
    };

    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Error fetching payroll data:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }

};

// exports.updateAttendance = async (req, res) => {
//   try {
//     const { id } = req.params;
//     const { status, checkIn, checkOut, overtimeHours, remarks, date } = req.body;

//     console.log('Updating attendance:', { id, status, checkIn, checkOut, overtimeHours, remarks });

//     // Check if attendance record exists
//     const [existing] = await db.query(
//       "SELECT id FROM attendance WHERE id = ?",
//       [id]
//     );

//     if (existing.length === 0) {
//       return res.status(404).json({ success: false, message: 'Attendance record not found' });
//     }

//     // Build update object with only provided fields
//     const updateFields = {
//       updated_at: new Date()
//     };

//     if (status) updateFields.status = status;
//     if (checkIn) updateFields.check_in = checkIn;
//     if (checkOut) updateFields.check_out = checkOut;
//     if (overtimeHours) updateFields.overtime_hours = overtimeHours;
//     if (remarks) updateFields.remarks = remarks;

//     await db.query(
//       `UPDATE attendance 
//        SET ?
//        WHERE id = ?`,
//       [updateFields, id]
//     );

//     res.json({ success: true, message: 'Attendance updated successfully' });
//   } catch (error) {
//     console.error('Error updating attendance:', error);
//     res.status(500).json({ success: false, message: 'Server error' });
//   }
// };

// Delete attendance record
// exports.deleteAttendance = async (req, res) => {
//   const conn = await db.getConnection();
  
//   try {
//     await conn.beginTransaction();

//     const { id } = req.params;

//     console.log('🗑️ Deleting attendance record:', id);

//     // Get attendance record before deletion for logging
//     const [existingRecords] = await conn.execute(
//       `SELECT a.*, e.employeeName 
//        FROM attendance a 
//        JOIN employees e ON a.employee_id = e.id 
//        WHERE a.id = ?`,
//       [id]
//     );

//     if (existingRecords.length === 0) {
//       await conn.rollback();
//       return res.status(404).json({ 
//         success: false, 
//         message: 'Attendance record not found' 
//       });
//     }

//     const existingRecord = existingRecords[0];

//     // Delete the attendance record
//     await conn.execute('DELETE FROM attendance WHERE id = ?', [id]);

//     // Commit transaction FIRST
//     await conn.commit();

//     // THEN log the deletion OUTSIDE the transaction
//     await logAttendanceDeletion(id, req);

//     console.log('✅ Attendance record deleted successfully with logging');

//     res.json({ 
//       success: true, 
//       message: 'Attendance record deleted successfully',
//       deletedRecord: {
//         id: id,
//         employeeName: existingRecord.employeeName,
//         date: existingRecord.date,
//         status: existingRecord.status
//       }
//     });
//   } catch (error) {
//     await conn.rollback();
//     console.error('❌ Error deleting attendance:', error);
    
//     // Log the error
//     await logAttendanceAction(
//       parseInt(id),
//       'delete_failed',
//       `Failed to delete attendance record: ${error.message}`,
//       { error: error.message },
//       req
//     );

//     res.status(500).json({ 
//       success: false, 
//       message: 'Server error while deleting attendance',
//       error: error.message 
//     });
//   } finally {
//     conn.release();
//   }
// };

// exports.todayAttendance = async (req, res) => {
//   try {
//     const { date } = req.query;
//     const targetDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

//     console.log('Fetching today attendance for date:', targetDate);

//     const [attendance] = await db.query(`
//       SELECT 
//         a.id as attendance_id,
//         a.employee_id,
//         a.status,
//         a.check_in,
//         a.check_out,
//         a.overtime_hours,
//         a.remarks,
//         a.date as attendance_date,
//         e.id as employee_id,
//         e.employeeName as employee_name,
//         e.department,
//         e.position,
//         e.phone,
//         e.balance,
//         e.last_month_due
//       FROM attendance a
//       JOIN employees e ON a.employee_id = e.id
//       WHERE DATE(a.date) = ?
//       ORDER BY e.employeeName
//     `, [targetDate]);

//     console.log(`Found ${attendance.length} attendance records for ${targetDate}`);

//     res.json({ 
//       success: true, 
//       data: attendance,
//       count: attendance.length,
//       date: targetDate
//     });
//   } catch (error) {
//     console.error('Error fetching today attendance:', error);
//     res.status(500).json({ 
//       success: false, 
//       message: 'Error fetching today attendance',
//       error: error.message 
//     });
//   }
// };

// exports.markAttendance = async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({ errors: errors.array() });
//     }

//     const { employeeId, status, date, checkIn, checkOut, remarks = '' } = req.body;
    
//     const targetDate = date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

//     console.log('Marking attendance for:', { employeeId, status, targetDate, checkIn, checkOut });

//     // Check if attendance already exists
//     const [existing] = await db.query(
//       "SELECT id, check_in, check_out FROM attendance WHERE employee_id = ? AND DATE(date) = ?",
//       [employeeId, targetDate]
//     );

//     let updateData = { status, remarks, updated_at: new Date() };
    
//     // Only update check_in if it's provided and not already set
//     if (checkIn && (!existing[0]?.check_in || existing[0]?.check_in === '00:00:00')) {
//       updateData.check_in = checkIn;
//     }
    
//     // Only update check_out if it's provided
//     if (checkOut) {
//       updateData.check_out = checkOut;
//     }

//     if (existing.length > 0) {
//       // Update existing attendance
//       await db.query(
//         `UPDATE attendance 
//          SET ? 
//          WHERE employee_id = ? AND DATE(date) = ?`,
//         [updateData, employeeId, targetDate]
//       );
      
//       console.log('Updated existing attendance record');
//     } else {
//       // Create new attendance record
//       const newData = {
//         employee_id: employeeId,
//         date: targetDate,
//         status: status,
//         remarks: remarks,
//         created_at: new Date(),
//         updated_at: new Date()
//       };
      
//       if (checkIn) newData.check_in = checkIn;
//       if (checkOut) newData.check_out = checkOut;
      
//       await db.query(
//         `INSERT INTO attendance SET ?`,
//         [newData]
//       );
      
//       console.log('Created new attendance record');
//     }

//     // Update employee status in employees table
//     await db.query(
//       `UPDATE employees 
//        SET status = ?, updatedAt = NOW()
//        WHERE id = ?`,
//       [status, employeeId]
//     );

//     console.log('Updated employee status in employees table');

//     res.json({ success: true, message: 'Attendance marked successfully' });
//   } catch (error) {
//     console.error('Error marking attendance:', error);
//     res.status(500).json({ success: false, message: 'Server error' });
//   }
// };

// Save attendance settings
exports.saveAttendanceSettings = async (req, res) => {
  try {
    const settings = req.body;
    
    // Validate required fields
    if (!settings.workingHours || !settings.weeklyOff) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required settings fields' 
      });
    }

    const [existing] = await db.query(`
      SELECT id FROM attendance_settings WHERE id = 1
    `);

    const settingsJson = JSON.stringify(settings);
    const now = new Date();

    if (existing.length > 0) {
      // Update existing settings
      await db.query(`
        UPDATE attendance_settings 
        SET settings_data = ?, updated_at = ?
        WHERE id = 1
      `, [settingsJson, now]);
    } else {
      // Insert new settings
      await db.query(`
        INSERT INTO attendance_settings (id, settings_data, created_at, updated_at)
        VALUES (1, ?, ?, ?)
      `, [settingsJson, now, now]);
    }

    res.json({ 
      success: true, 
      message: 'Settings saved successfully',
      data: settings 
    });
  } catch (error) {
    console.error('Error saving attendance settings:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while saving settings' 
    });
  }
};

exports.getMyAttendance = async (req, res) => {
  try {
    const { month, year } = req.query;
    const employeeId = await getEmployeeId(req);

    if (!employeeId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Employee ID not found' 
      });
    }

    // Calculate date range for the month
    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    console.log('Fetching my attendance for:', { employeeId, startDate, endDate });

    const [attendance] = await db.query(`
      SELECT 
        id,
        date,
        status,
        check_in as checkIn,
        check_out as checkOut,
        overtime_hours as overtimeHours,
        overtime_amount as overtimeAmount,
        remarks
      FROM attendance 
      WHERE employee_id = ? 
        AND date BETWEEN ? AND ?
      ORDER BY date DESC
    `, [employeeId, startDate, endDate]);

    res.json({
      success: true,
      data: attendance,
      count: attendance.length
    });
  } catch (error) {
    console.error('Get my attendance error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching attendance' 
    });
  }
};

// Get logged-in user's attendance summary
exports.getMyAttendanceSummary = async (req, res) => {
  try {
    const { month, year } = req.query;
    const employeeId = await getEmployeeId(req);

    if (!employeeId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Employee ID not found' 
      });
    }

    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    console.log('Fetching my attendance summary for:', { employeeId, startDate, endDate });

    const [attendance] = await db.query(`
      SELECT 
        status,
        COUNT(*) as count
      FROM attendance 
      WHERE employee_id = ? 
        AND date BETWEEN ? AND ?
      GROUP BY status
    `, [employeeId, startDate, endDate]);

    // Initialize summary with zeros
    const summary = {
      present: 0,
      absent: 0,
      halfDay: 0,
      paidLeave: 0,
      weeklyOff: 0,
      total: 0
    };

    // Update counts based on database results
    attendance.forEach(item => {
      const status = item.status.toLowerCase().replace(' ', '');
      if (summary.hasOwnProperty(status)) {
        summary[status] = item.count;
      }
    });

    // Calculate total
    summary.total = attendance.reduce((total, item) => total + parseInt(item.count), 0);

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    console.error('Get my attendance summary error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching attendance summary' 
    });
  }
};

// Get logged-in user's attendance statistics for charts
exports.getMyAttendanceStats = async (req, res) => {
  try {
    const { year } = req.query;
    const employeeId = await getEmployeeId(req);

    if (!employeeId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Employee ID not found' 
      });
    }

    console.log('Fetching my attendance stats for year:', year);

    const monthlyStats = [];
    
    // Get stats for each month of the year
    for (let month = 1; month <= 12; month++) {
      const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
      const endDate = new Date(year, month, 0).toISOString().split('T')[0];

      const [attendance] = await db.query(`
        SELECT 
          status,
          COUNT(*) as count
        FROM attendance 
        WHERE employee_id = ? 
          AND date BETWEEN ? AND ?
        GROUP BY status
      `, [employeeId, startDate, endDate]);

      // Initialize monthly stats
      const monthStats = {
        month: month,
        present: 0,
        absent: 0,
        halfDay: 0,
        paidLeave: 0,
        weeklyOff: 0,
        total: 0
      };

      // Update counts based on database results
      attendance.forEach(item => {
        const status = item.status.toLowerCase().replace(' ', '');
        if (monthStats.hasOwnProperty(status)) {
          monthStats[status] = item.count;
        }
      });

      // Calculate total
      monthStats.total = attendance.reduce((total, item) => total + parseInt(item.count), 0);

      monthlyStats.push(monthStats);
    }

    res.json({
      success: true,
      data: monthlyStats
    });
  } catch (error) {
    console.error('Get my attendance stats error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching attendance statistics' 
    });
  }
};

exports.getAttendanceByPeriod = async (req, res) => {
  try {
    const { period, startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ 
        success: false, 
        message: 'Start date and end date are required' 
      });
    }

    console.log('Fetching attendance for period:', { period, startDate, endDate });

    // Get attendance records for the date range
    const [attendance] = await db.query(`
      SELECT 
        a.id as attendance_id,
        a.employee_id,
        a.status,
        a.check_in,
        a.check_out,
        a.overtime_hours,
        a.remarks,
        a.location_data as locationData,
        a.date as attendance_date,
        e.id as employee_id,
        e.employeeName as employee_name,
        e.department,
        e.position,
        e.phone,
        e.balance,
        e.last_month_due
      FROM attendance a
      JOIN employees e ON a.employee_id = e.id
      WHERE a.date BETWEEN ? AND ?
      ORDER BY a.date DESC, e.employeeName
    `, [startDate, endDate]);

    // Calculate summary statistics
    const [summary] = await db.query(`
      SELECT 
        COUNT(CASE WHEN status = 'Present' THEN 1 END) as present,
        COUNT(CASE WHEN status = 'Absent' THEN 1 END) as absent,
        COUNT(CASE WHEN status = 'Half Day' THEN 1 END) as halfDay,
        COUNT(CASE WHEN status = 'Paid Leave' THEN 1 END) as paidLeave,
        COUNT(CASE WHEN status = 'Weekly Off' THEN 1 END) as weeklyOff,
        COUNT(*) as total
      FROM attendance 
      WHERE date BETWEEN ? AND ?
    `, [startDate, endDate]);

    // Parse location data
    const attendanceWithLocation = attendance.map(record => {
      if (record.locationData) {
        try {
          record.locationData = JSON.parse(record.locationData);
        } catch (e) {
          record.locationData = null;
        }
      }
      return record;
    });

    res.json({
      success: true,
      data: attendanceWithLocation,
      summary: {
        present: summary[0]?.present || 0,
        absent: summary[0]?.absent || 0,
        halfDay: summary[0]?.halfDay || 0,
        paidLeave: summary[0]?.paidLeave || 0,
        weeklyOff: summary[0]?.weeklyOff || 0,
        total: summary[0]?.total || 0
      },
      period: {
        type: period,
        startDate,
        endDate
      },
      count: attendance.length
    });
  } catch (error) {
    console.error('Error fetching attendance by period:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching attendance by period' 
    });
  }
};

exports.getAttendanceLogs = async (req, res) => {
  try {
    const { attendanceId } = req.params;
    
    const [logs] = await db.execute(
      `SELECT 
        al.*,
        a.employee_id,
        e.employeeName,
        a.date as attendanceDate
       FROM attendance_logs al
       JOIN attendance a ON al.attendanceId = a.id
       JOIN employees e ON a.employee_id = e.id
       WHERE al.attendanceId = ? 
       ORDER BY al.createdAt DESC`,
      [attendanceId]
    );

    // Parse JSON changes field
    const parsedLogs = logs.map(log => ({
      ...log,
      changes: log.changes ? (typeof log.changes === 'string' ? JSON.parse(log.changes) : log.changes) : {}
    }));

    res.json({
      success: true,
      data: parsedLogs,
      count: parsedLogs.length
    });
  } catch (error) {
    console.error('Error fetching attendance logs:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching attendance logs',
      error: error.message 
    });
  }
};

// Get all attendance logs with pagination and filters
exports.getAllAttendanceLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50, employeeId, action, startDate, endDate } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT 
        al.*, 
        a.employee_id, 
        e.employeeName, 
        a.date as attendanceDate,
        a.status as attendanceStatus
      FROM attendance_logs al
      JOIN attendance a ON al.attendanceId = a.id
      JOIN employees e ON a.employee_id = e.id
      WHERE 1=1
    `;
    
    const params = [];

    // Add filters
    if (employeeId) {
      query += ' AND a.employee_id = ?';
      params.push(employeeId);
    }
    
    if (action) {
      query += ' AND al.action = ?';
      params.push(action);
    }
    
    if (startDate) {
      query += ' AND DATE(al.createdAt) >= ?';
      params.push(startDate);
    }
    
    if (endDate) {
      query += ' AND DATE(al.createdAt) <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY al.createdAt DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const [logs] = await db.execute(query, params);

    // Parse JSON changes field
    const parsedLogs = logs.map(log => ({
      ...log,
      changes: log.changes ? (typeof log.changes === 'string' ? JSON.parse(log.changes) : log.changes) : {}
    }));

    // Get total count for pagination
    let countQuery = `
      SELECT COUNT(*) as total
      FROM attendance_logs al
      JOIN attendance a ON al.attendanceId = a.id
      WHERE 1=1
    `;
    
    const countParams = [];
    
    if (employeeId) {
      countQuery += ' AND a.employee_id = ?';
      countParams.push(employeeId);
    }
    
    if (action) {
      countQuery += ' AND al.action = ?';
      countParams.push(action);
    }
    
    if (startDate) {
      countQuery += ' AND DATE(al.createdAt) >= ?';
      countParams.push(startDate);
    }
    
    if (endDate) {
      countQuery += ' AND DATE(al.createdAt) <= ?';
      countParams.push(endDate);
    }

    const [totalCount] = await db.execute(countQuery, countParams);

    res.json({
      success: true,
      data: parsedLogs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: totalCount[0].total,
        pages: Math.ceil(totalCount[0].total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching all attendance logs:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching attendance logs',
      error: error.message 
    });
  }
};

// Get attendance log statistics
exports.getAttendanceLogStats = async (req, res) => {
  try {
    const { period = '30days' } = req.query;
    
    let dateFilter = '';
    let dateParams = [];
    
    if (period === '7days') {
      dateFilter = ' AND al.createdAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
    } else if (period === '30days') {
      dateFilter = ' AND al.createdAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)';
    } else if (period === '90days') {
      dateFilter = ' AND al.createdAt >= DATE_SUB(NOW(), INTERVAL 90 DAY)';
    }

    // Get action counts
    const [actionCounts] = await db.execute(
      `SELECT action, COUNT(*) as count 
       FROM attendance_logs al
       WHERE 1=1 ${dateFilter}
       GROUP BY action 
       ORDER BY count DESC`,
      dateParams
    );

    // Get top users
    const [topUsers] = await db.execute(
      `SELECT userName, COUNT(*) as count 
       FROM attendance_logs 
       WHERE userName IS NOT NULL AND userName != 'System'
       GROUP BY userName 
       ORDER BY count DESC 
       LIMIT 10`
    );

    // Get daily activity
    const [dailyActivity] = await db.execute(
      `SELECT DATE(createdAt) as date, COUNT(*) as count 
       FROM attendance_logs 
       WHERE createdAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       GROUP BY DATE(createdAt) 
       ORDER BY date DESC`
    );

    // Get total stats
    const [totalStats] = await db.execute(
      `SELECT 
        COUNT(*) as totalLogs,
        COUNT(DISTINCT attendanceId) as uniqueRecords,
        COUNT(DISTINCT userName) as uniqueUsers
       FROM attendance_logs 
       WHERE 1=1 ${dateFilter}`,
      dateParams
    );

    res.json({
      success: true,
      data: {
        actionCounts,
        topUsers,
        dailyActivity,
        totalStats: totalStats[0]
      }
    });
  } catch (error) {
    console.error('Error fetching attendance log stats:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Error fetching attendance log statistics',
      error: error.message 
    });
  }
};