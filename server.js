require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const db = require("./config/db");
const path = require("path");
const employeeController = require('./controllers/employeeController');

const app = express();
app.set('trust proxy', true);

// Alternative: Trust specific AWS and cloud provider IP ranges
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

// Or be more specific for AWS:
app.set('trust proxy', function (ip) {
  // Trust AWS internal IPs and common cloud providers
  if (ip.startsWith('172.31.') || // AWS VPC
      ip.startsWith('10.') ||     // Private network
      ip.startsWith('192.168.') || // Private network
      ip === '127.0.0.1' ||       // Localhost
      ip === '::1') {             // IPv6 localhost
    return true;
  }
  return false;
});

console.log('🔧 Proxy trust configuration enabled');

// Or for specific IP ranges:
// app.set('trust proxy', ['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12']);

const cron = require('node-cron');
const { checkAndSendReminderNotifications } = require('./controllers/employeeController');

/* -------------------- Initialize Reminder System -------------------- */
const initializeReminderSystem = async () => {
  try {
    console.log('🔄 Initializing reminder system...');
    
    // Update reminder times from settings first
    await employeeController.reminderScheduler.updateReminderTimes();
    
    // Start the complete reminder scheduler (includes both check-in AND checkout)
    const schedulerStatus = await employeeController.reminderScheduler.start();
    console.log('✅ Complete reminder scheduler started:', {
      checkinTime: schedulerStatus.checkinFormatted,
      workingHours: schedulerStatus.workingHoursFormatted,
      isRunning: schedulerStatus.isRunning,
      workingMinutes: schedulerStatus.workingMinutes
    });
    
    // Start the attendance notification interval
    employeeController.setupReminderInterval();
    console.log('✅ Attendance reminder interval started');
    
    // Test the system by checking current status
    const debugInfo = await getReminderDebugInfo();
    console.log('📊 Reminder system initialized:', {
      employeesWithoutCheckout: debugInfo.employeesWithoutCheckout,
      schedulerRunning: debugInfo.schedulerRunning,
      workingHours: debugInfo.workingHours
    });
    
  } catch (error) {
    console.error('❌ Failed to initialize reminder system:', error);
  }
};

// Helper function to get debug info
const getReminderDebugInfo = async () => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const employeesWithoutCheckout = await employeeController.reminderScheduler.getEmployeesWithoutCheckout();
    const schedulerStatus = employeeController.reminderScheduler.getSchedulerStatus();
    
    return {
      employeesWithoutCheckout: employeesWithoutCheckout.length,
      schedulerRunning: schedulerStatus.isRunning,
      workingHours: schedulerStatus.workingHours,
      workingMinutes: schedulerStatus.workingMinutes
    };
  } catch (error) {
    console.error('Error getting debug info:', error);
    return { error: error.message };
  }
};

// Initialize reminder system when server starts
initializeReminderSystem();

/* -------------------- Schedule Regular Attendance Reminder Checks -------------------- */
cron.schedule('* * * * *', async () => {
  try {
    const result = await checkAndSendReminderNotifications();
    if (result.success && result.usersNotified > 0) {
      console.log(`✅ Sent ${result.usersNotified} attendance reminders`);
    }
  } catch (error) {
    console.error('❌ Error in attendance reminder check:', error);
  }
});

/* -------------------- Additional Checkout Reminder Cron (Backup) -------------------- */
// This is a backup cron that runs every 10 minutes during extended working hours
cron.schedule('*/10 9-22 * * *', async () => {
  const currentTime = new Date().toLocaleTimeString('en-IN', { 
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  });
  
  console.log(`🔄 [${currentTime}] Running backup checkout reminder check...`);
  
  try {
    const employees = await employeeController.reminderScheduler.getEmployeesWithoutCheckout();
    if (employees.length > 0) {
      console.log(`🔔 Backup cron: Found ${employees.length} employees without checkout`);
      const results = await employeeController.reminderScheduler.sendDynamicCheckoutReminders();
      
      if (results && results.length > 0) {
        console.log(`✅ Backup cron: Sent ${results.length} checkout reminders`);
        
        // Log details of sent reminders
        results.forEach(result => {
          if (!result.error) {
            console.log(`   📧 Sent ${result.reminderType} to ${result.employeeName}`);
          }
        });
      }
    } else {
      console.log('ℹ️  Backup cron: All employees have checked out');
    }
  } catch (error) {
    console.error('❌ Error in backup checkout reminder:', error);
  }
}, {
  timezone: "Asia/Kolkata"
});

/* -------------------- Health Check for Reminder System -------------------- */
cron.schedule('0 */6 * * *', async () => {
  console.log('🏥 Running reminder system health check...');
  try {
    const schedulerStatus = employeeController.reminderScheduler.getSchedulerStatus();
    const employeesWithoutCheckout = await employeeController.reminderScheduler.getEmployeesWithoutCheckout();
    
    console.log('📊 Reminder System Health:', {
      isRunning: schedulerStatus.isRunning,
      checkinTime: schedulerStatus.checkinFormatted,
      workingHours: schedulerStatus.workingHoursFormatted,
      employeesWithoutCheckout: employeesWithoutCheckout.length,
      lastHealthCheck: new Date().toISOString()
    });
    
    // Auto-restart if scheduler is not running but should be
    if (!schedulerStatus.isRunning) {
      console.log('🔄 Scheduler not running, attempting restart...');
      await employeeController.reminderScheduler.start();
    }
    
  } catch (error) {
    console.error('❌ Error in reminder system health check:', error);
  }
});

/* -------------------- Middleware -------------------- */
app.use(cors());
app.use(bodyParser.json({ 
  limit: '50mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

app.use(bodyParser.urlencoded({ 
  extended: true, 
  limit: '50mb' 
}));

/* -------------------- Test DB Connection -------------------- */
db.getConnection()
  .then((connection) => {
    console.log("✅ MySQL connected successfully!");
    connection.release();
  })
  .catch((err) => {
    console.error("❌ MySQL connection error:", err);
  });

/* -------------------- CRM Core Routes -------------------- */
const partyRoutes = require("./routes/parties");
const employeeRoutes = require("./routes/employeeRoutes");
const billingRoutes = require("./routes/billingRoutes");
const bankRoutes = require("./routes/bankDetailsRoutes");
const invoices = require('./routes/invoices');
const creditRoutes = require('./routes/creditNotes');
const paymentOutRoutes = require("./routes/paymentOut");
const paymentInRoutes = require("./routes/payments");
const challanRoutes = require("./routes/deliveryChallan");
const proformaRoutes = require('./routes/ProformaRoutes');
const purchaseInvoices = require("./routes/purchaseInvoices"); 
const debitNotes = require("./routes/debitNotes");
const purchaseOrderRoutes = require('./routes/purchaseOrderRoutes');
const attendanceRoutes = require('./routes/AttendanceRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const authRoutes = require("./routes/auth");
const leaveRoutes = require('./routes/leaveRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const staffRoutes = require('./routes/staff');
const employeeRequestRoutes = require('./routes/employeeRequestRoutes');
const announcementRoutes = require('./routes/announcements');
const projectsRoutes = require('./routes/projects');
const poPurchaseOrdersRoutes = require('./routes/projectPo');
const poSalesRoutes = require('./routes/projectSales');
const ewayBillRoutes = require('./routes/ewayBillRoutes');
const boqRoutes = require('./routes/boqRoutes');
const vendorPoRoutes = require("./routes/vendorPoRoutes");
const cronRoutes = require('./routes/cronRoutes');
const cronScheduler = require('./cron/scheduler'); 

app.use("/api/employees", employeeRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/banks", bankRoutes);
app.use("/api/parties", partyRoutes);
app.use('/api/invoices', invoices);
app.use('/api/credit-notes', creditRoutes);
app.use("/api/payments-out", paymentOutRoutes);
app.use("/api/payments-in", paymentInRoutes);
app.use('/api/delivery-challans', challanRoutes); 
app.use('/api/proforma-invoices', proformaRoutes);
app.use("/api/purchase-invoices", purchaseInvoices); 
app.use("/api/debit-notes", debitNotes);
app.use('/api/purchase-orders', purchaseOrderRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/transactions', transactionRoutes);
app.use("/api/auth", authRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/reminders', require('./routes/reminderRoutes'));
app.use('/api/employee-requests', employeeRequestRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/project-po', poPurchaseOrdersRoutes);
app.use('/api/project-sales', poSalesRoutes);
app.use('/api/ewaybills', ewayBillRoutes);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api/boq', boqRoutes);
app.use("/api/vendor-pos", vendorPoRoutes);
app.use('/api', cronRoutes);
cronScheduler.startScheduler();

console.log('🚀 Application started with daily absent marking scheduler');


// If you want to serve through API route as well, keep this:
app.use('/api/uploads', express.static(path.join(__dirname, 'uploads')));

/* -------------------- Settings Routes -------------------- */
const profileRoutes = require("./routes/profileRoutes");
const preferencesRoutes = require("./routes/preferencesRoutes");
const securityRoutes = require("./routes/securityRoutes");
const appearanceRoutes = require("./routes/appearanceRoutes");
const paymentRoutes = require("./routes/paymentRoutes");

app.use("/api/settings/profile", profileRoutes);
app.use("/api/settings/preferences", preferencesRoutes);
app.use("/api/settings/security", securityRoutes);
app.use("/api/settings/appearance", appearanceRoutes);
app.use("/api/settings/payment", paymentRoutes);

const reportRoutes = require("./routes/reportRoutes");
const partyReportRoutes = require('./routes/partyReportRoutes');
const itemReportRoutes = require("./routes/itemReportRoutes");
const itemRoutes = require("./routes/itemRoutes");
const paymentInReportRoutes = require("./routes/paymentInReportRoutes");
const paymentOutReportRoutes = require("./routes/paymentOutReportRoutes");
const invoiceReportRoutes = require("./routes/invoiceReportRoutes");
const crmDashboardRoutes = require('./routes/crmDashboardRoutes');

const settingsRoutes = require('./routes/settingsRoutes');

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'build')));

// Base report routes
app.use("/api/reports", reportRoutes);
app.use('/api/party-reports', partyReportRoutes);
app.use('/api/item-reports', itemReportRoutes);
app.use("/api/items", itemRoutes);
app.use("/api/reports/payment-in", paymentInReportRoutes);
app.use("/api/reports/payment-out", paymentOutReportRoutes);
app.use('/api/invoice-reports', invoiceReportRoutes);
app.use('/api/crm', crmDashboardRoutes);
app.use('/api/settings', settingsRoutes);

/* -------------------- Reminder System Status Endpoint -------------------- */
app.get('/api/reminder-system/status', async (req, res) => {
  try {
    const schedulerStatus = employeeController.reminderScheduler.getSchedulerStatus();
    const employeesWithoutCheckout = await employeeController.reminderScheduler.getEmployeesWithoutCheckout();
    const employeesWithoutCheckin = await employeeController.reminderScheduler.getEmployeesWithoutCheckin();
    
    res.json({
      success: true,
      data: {
        scheduler: {
          isRunning: schedulerStatus.isRunning,
          checkinReminderTime: schedulerStatus.checkinReminderTime,
          workingHours: schedulerStatus.workingHours,
          workingHoursFormatted: schedulerStatus.workingHoursFormatted,
          checkinCron: schedulerStatus.checkinCron,
          checkoutCron: '*/5 12-22 * * *',
          backupCron: '*/10 9-22 * * *'
        },
        statistics: {
          employeesWithoutCheckin: employeesWithoutCheckin.length,
          employeesWithoutCheckout: employeesWithoutCheckout.length,
          totalActiveEmployees: employeesWithoutCheckin.length + employeesWithoutCheckout.length
        },
        serverTime: {
          current: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
          timezone: 'Asia/Kolkata'
        },
        lastHealthCheck: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error getting reminder system status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get reminder system status',
      error: error.message
    });
  }
});

/* -------------------- Manual Reminder Trigger Endpoints -------------------- */
app.post('/api/reminder-system/trigger-checkin', async (req, res) => {
  try {
    console.log('🔄 Manually triggering check-in reminders...');
    const results = await employeeController.reminderScheduler.sendCheckinReminders();
    
    res.json({
      success: true,
      message: 'Check-in reminders triggered manually',
      data: {
        totalProcessed: results.length,
        results: results
      }
    });
  } catch (error) {
    console.error('Error triggering check-in reminders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger check-in reminders',
      error: error.message
    });
  }
});

app.post('/api/reminder-system/trigger-checkout', async (req, res) => {
  try {
    console.log('🔄 Manually triggering checkout reminders...');
    const results = await employeeController.reminderScheduler.sendDynamicCheckoutReminders();
    
    res.json({
      success: true,
      message: 'Checkout reminders triggered manually',
      data: {
        totalProcessed: results.length,
        results: results
      }
    });
  } catch (error) {
    console.error('Error triggering checkout reminders:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to trigger checkout reminders',
      error: error.message
    });
  }
});

/* -------------------- Default Route -------------------- */
app.get("/", (req, res) => {
  res.json({
    message: "🌊 Welcome to Icebergs CRM Backend API!",
    version: "1.0.0",
    features: {
      reminderSystem: true,
      attendanceTracking: true,
      smsNotifications: true,
      emailNotifications: true
    },
    endpoints: {
      reminderStatus: "/api/reminder-system/status",
      triggerCheckin: "/api/reminder-system/trigger-checkin",
      triggerCheckout: "/api/reminder-system/trigger-checkout"
    }
  });
});

/* -------------------- 404 Handler -------------------- */
app.use((req, res) => {
  res.status(404).json({ 
    error: "❌ Route not found",
    path: req.path,
    method: req.method 
  });
});

/* -------------------- Global Error Handler -------------------- */
app.use((err, req, res, next) => {
  console.error("🔥 Server Error:", err.stack);
  res.status(500).json({ 
    error: "Internal Server Error",
    message: err.message
  });
});

/* -------------------- Graceful Shutdown -------------------- */
process.on('SIGINT', () => {
  console.log('🛑 Shutting down reminder scheduler gracefully...');
  employeeController.reminderScheduler.stop();
  console.log('✅ Reminder scheduler stopped');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Shutting down reminder scheduler gracefully...');
  employeeController.reminderScheduler.stop();
  console.log('✅ Reminder scheduler stopped');
  process.exit(0);
});

/* -------------------- Start Server -------------------- */
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`🚀 Icebergs CRM Backend running on http://localhost:${PORT}`);
  console.log('⏰ Reminder System Features:');
  console.log('   ✅ Check-in reminders (from settings)');
  console.log('   ✅ Dynamic checkout reminders (every 5 minutes, 12PM-10PM)');
  console.log('   ✅ Backup checkout reminders (every 10 minutes, 9AM-10PM)');
  console.log('   ✅ Panel notifications & SMS/Email alerts');
  console.log('   ✅ Health checks (every 6 hours)');
  console.log('   ✅ Manual trigger endpoints available');
  console.log('   ✅ Graceful shutdown handling');
  console.log('');
  console.log('🔧 Available Endpoints:');
  console.log('   GET  /api/reminder-system/status');
  console.log('   POST /api/reminder-system/trigger-checkin');
  console.log('   POST /api/reminder-system/trigger-checkout');
});

// Export for testing
module.exports = app;