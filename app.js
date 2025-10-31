const express = require('express');
const cors = require('cors');
const bodyParser = require('express').json;
const authStub = require('./middleware/authStub');

const clients = require('./routes/clients');
const products = require('./routes/products');
const invoices = require('./routes/invoices');
const payments = require('./routes/payments');
const partyRoutes = require("./routes/parties");
const itemRoutes = require("./routes/itemRoutes");
const purchaseInvoices = require("./routes/purchaseInvoices"); 
const authRoutes = require("./routes/auth");
const authMiddleware = require("./middleware/authMiddleware");
const debitNotes = require("./routes/debitNotes");
const creditNoteRoutes = require("./routes/creditNotes");
const deliveryRoutes = require("./routes/delivery");
const challanRoutes = require("./routes/deliveryChallan");
const paymentOutRoutes = require("./routes/paymentOut");


const app = express();
app.use(cors());
app.use(bodyParser());
app.use(authStub);

app.use('/api/clients', clients);
app.use('/api/products', products);
app.use('/api/invoices', invoices);
app.use('/api/payments', payments);
app.use("/api/auth", authRoutes);
app.use("/api/debit-notes", debitNotes);
app.use("/api/credit-notes", creditNoteRoutes);
app.use("/api/parties", partyRoutes);
app.use("/api/purchase-invoices", purchaseInvoices); 
app.use("/api/delivery", deliveryRoutes); 
app.use("/api/challans", deliveryRoutes);
app.use("/api/challans", challanRoutes);
app.use("/api/payments-out", paymentOutRoutes);

app.get('/', (req, res) => res.json({ message: 'CRM Billing API' }));

module.exports = app;
