const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const PurchaseOrder = require('../models/PurchaseOrder');
const GRN = require('../models/GRN');
const Invoice = require('../models/Invoice');
const { parseDocumentWithGemini } = require('../services/geminiService');
const { triggerMatching } = require('../services/matchingService');

// ─── POST /documents/upload ───────────────────────────────────────────────────

const uploadDocument = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded.' });
  }

  const { documentType } = req.body;
  const allowedTypes = ['po', 'grn', 'invoice'];

  if (!documentType || !allowedTypes.includes(documentType.toLowerCase())) {
    // Clean up uploaded file
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({
      success: false,
      message: `Invalid documentType. Must be one of: ${allowedTypes.join(', ')}`,
    });
  }

  const docType = documentType.toLowerCase();
  const documentId = uuidv4();
  const filePath = req.file.path;
  const mimeType = req.file.mimetype;
  const originalFileName = req.file.originalname;

  let parsed;
  let rawText;

  // ── Step 1: Parse with Gemini ─────────────────────────────────────────────
  try {
    const geminiResult = await parseDocumentWithGemini(filePath, docType, mimeType);
    parsed = geminiResult.parsed;
    rawText = geminiResult.rawText;
  } catch (geminiError) {
    fs.unlink(filePath, () => {});
    return res.status(422).json({
      success: false,
      message: `Gemini parsing failed: ${geminiError.message}`,
    });
  }

  // ── Step 2: Save to MongoDB ───────────────────────────────────────────────
  let savedDoc;
  let poNumber;

  try {
    const commonFields = {
      documentId,
      filePath,
      originalFileName,
      mimeType,
      rawExtractedText: rawText,
    };

    if (docType === 'po') {
      // Check for duplicate PO number
      const existing = await PurchaseOrder.findOne({ poNumber: parsed.poNumber });
      if (existing) {
        // Still save it (duplicate_po will be flagged by matching service)
        console.warn(`⚠️  Duplicate PO number detected: ${parsed.poNumber}`);
      }

      savedDoc = await PurchaseOrder.create({
        ...commonFields,
        poNumber: parsed.poNumber,
        poDate: parsed.poDate ? new Date(parsed.poDate) : null,
        vendorName: parsed.vendorName,
        vendorAddress: parsed.vendorAddress,
        buyerName: parsed.buyerName,
        currency: parsed.currency,
        totalAmount: parsed.totalAmount,
        items: parsed.items || [],
      });
      poNumber = parsed.poNumber;

    } else if (docType === 'grn') {
      savedDoc = await GRN.create({
        ...commonFields,
        grnNumber: parsed.grnNumber,
        poNumber: parsed.poNumber,
        grnDate: parsed.grnDate ? new Date(parsed.grnDate) : null,
        receivedBy: parsed.receivedBy,
        warehouse: parsed.warehouse,
        items: parsed.items || [],
      });
      poNumber = parsed.poNumber;

    } else if (docType === 'invoice') {
      savedDoc = await Invoice.create({
        ...commonFields,
        invoiceNumber: parsed.invoiceNumber,
        poNumber: parsed.poNumber,
        invoiceDate: parsed.invoiceDate ? new Date(parsed.invoiceDate) : null,
        vendorName: parsed.vendorName,
        vendorAddress: parsed.vendorAddress,
        buyerName: parsed.buyerName,
        currency: parsed.currency,
        totalAmount: parsed.totalAmount,
        taxAmount: parsed.taxAmount,
        items: parsed.items || [],
      });
      poNumber = parsed.poNumber;
    }
  } catch (dbError) {
    return res.status(500).json({
      success: false,
      message: `Database error: ${dbError.message}`,
    });
  }

  // ── Step 3: Trigger / Update Matching ─────────────────────────────────────
  let matchResult = null;
  try {
    matchResult = await triggerMatching(poNumber);
  } catch (matchError) {
    // Non-fatal: document is saved, matching will retry on next upload
    console.error('Matching error (non-fatal):', matchError.message);
  }

  return res.status(201).json({
    success: true,
    message: `${docType.toUpperCase()} document uploaded and parsed successfully.`,
    document: {
      id: savedDoc._id,
      documentId: savedDoc.documentId,
      documentType: docType,
      poNumber,
      originalFileName,
      uploadedAt: savedDoc.uploadedAt,
    },
    parsedData: parsed,
    matchStatus: matchResult
      ? { poNumber, status: matchResult.status }
      : null,
  });
};

// ─── GET /documents/:id ───────────────────────────────────────────────────────

const getDocumentById = async (req, res) => {
  const { id } = req.params;

  // Search across all three collections
  const [po, grn, invoice] = await Promise.all([
    PurchaseOrder.findById(id).catch(() => null),
    GRN.findById(id).catch(() => null),
    Invoice.findById(id).catch(() => null),
  ]);

  const doc = po || grn || invoice;
  if (!doc) {
    return res.status(404).json({
      success: false,
      message: `Document with id "${id}" not found.`,
    });
  }

  const docType = po ? 'po' : grn ? 'grn' : 'invoice';

  return res.status(200).json({
    success: true,
    documentType: docType,
    document: doc,
  });
};

// ─── GET /documents ───────────────────────────────────────────────────────────

const listDocuments = async (req, res) => {
  const { poNumber, type, page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const filter = poNumber ? { poNumber } : {};

  const [pos, grns, invoices] = await Promise.all([
    (!type || type === 'po')
      ? PurchaseOrder.find(filter)
          .select('documentId poNumber poDate vendorName uploadedAt')
          .skip(skip)
          .limit(parseInt(limit))
          .sort({ uploadedAt: -1 })
      : [],
    (!type || type === 'grn')
      ? GRN.find(filter)
          .select('documentId grnNumber poNumber grnDate uploadedAt')
          .skip(skip)
          .limit(parseInt(limit))
          .sort({ uploadedAt: -1 })
      : [],
    (!type || type === 'invoice')
      ? Invoice.find(filter)
          .select('documentId invoiceNumber poNumber invoiceDate uploadedAt')
          .skip(skip)
          .limit(parseInt(limit))
          .sort({ uploadedAt: -1 })
      : [],
  ]);

  return res.status(200).json({
    success: true,
    data: {
      purchaseOrders: pos,
      grns,
      invoices,
    },
  });
};

module.exports = { uploadDocument, getDocumentById, listDocuments };
