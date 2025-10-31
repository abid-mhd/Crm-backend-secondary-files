// Simple auth stub — replace with real JWT or session auth as needed
module.exports = (req, res, next) => {
  // For now allow everything; later validate req.headers.authorization
  req.user = { id: 1, name: 'dev' }; 
  next();
};
