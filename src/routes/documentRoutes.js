const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const {
  uploadDocument,
  getDocumentById,
  listDocuments,
} = require('../controllers/documentController');

// POST /documents/upload
router.post('/upload', upload.single('file'), uploadDocument);

// GET /documents
router.get('/', listDocuments);

// GET /documents/:id
router.get('/:id', getDocumentById);

module.exports = router;
