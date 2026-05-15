require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const documentRoutes = require('./routes/documentRoutes');
const matchRoutes = require('./routes/matchRoutes');

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Three-Way Match Engine',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/documents', documentRoutes);
app.use('/match', matchRoutes);

// ─── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found.`,
    availableRoutes: [
      'GET  /health',
      'POST /documents/upload',
      'GET  /documents',
      'GET  /documents/:id',
      'GET  /match',
      'GET  /match/:poNumber',
    ],
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      success: false,
      message: 'File too large. Maximum size is 20MB.',
    });
  }

  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error.',
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const start = async () => {
  await connectDB();
  app.listen(PORT, () => {
    console.log(`\n🚀 Three-Way Match Engine running on port ${PORT}`);
    console.log(`📋 Health: http://localhost:${PORT}/health`);
    console.log(`📄 Upload: POST http://localhost:${PORT}/documents/upload`);
    console.log(`🔍 Match:  GET  http://localhost:${PORT}/match/:poNumber\n`);
  });
};

start();

module.exports = app;
