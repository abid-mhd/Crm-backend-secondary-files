const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const employeeRoutes = require('./routes/employeeRoutes');
const billingRoutes = require('./routes/billingRoutes');

const app = express();
const PORT = 5001;

app.use(cors('*'));
app.use(bodyParser.json({ limit: '10mb' }));

app.use('/api/employees', employeeRoutes);
app.use('/api/billing/bills', billingRoutes);

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
