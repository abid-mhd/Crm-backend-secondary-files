require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const db = require("./config/db");
const path = require("path");
const { setupReminderInterval } = require('./controllers/employeeController');

setupReminderInterval();

const app = express();

const cron = require('node-cron');
const { checkAndSendReminderNotifications } = require('./controllers/employeeController');

cron.schedule('* * * * *', async () => {
  console.log('🕒 Running attendance reminder check...');
  await checkAndSendReminderNotifications();
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
    console.log("MySQL connected successfully!");
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



// app.use("/api/parties", partyRoutes);
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
app.use('/api/purchase-orders', purchaseOrderRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/transactions', transactionRoutes);
app.use("/api/auth", authRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/staff', staffRoutes);


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

/* -------------------- Default Route -------------------- */
app.get("/", (req, res) => {
  res.send("🌊 Welcome to Icebergs CRM Backend API!");
});

/* -------------------- 404 Handler -------------------- */
app.use((req, res) => {
  res.status(404).json({ error: "❌ Route not found" });
});

/* -------------------- Global Error Handler -------------------- */
app.use((err, req, res, next) => {
  console.error("🔥 Server Error:", err.stack);
  res.status(500).json({ error: "Internal Server Error" });
});

/* -------------------- Start Server -------------------- */
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`🚀 Icebergs CRM Backend running on http://localhost:${PORT}`);
});
