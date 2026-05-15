const MatchResult = require('../models/MatchResult');
const PurchaseOrder = require('../models/PurchaseOrder');
const GRN = require('../models/GRN');
const Invoice = require('../models/Invoice');
const { triggerMatching } = require('../services/matchingService');

// ─── GET /match/:poNumber ─────────────────────────────────────────────────────

const getMatchByPONumber = async (req, res) => {
  const { poNumber } = req.params;

  if (!poNumber) {
    return res.status(400).json({ success: false, message: 'poNumber is required.' });
  }

  // Check if any documents exist for this PO
  const [pos, grns, invoices] = await Promise.all([
    PurchaseOrder.find({ poNumber }),
    GRN.find({ poNumber }),
    Invoice.find({ poNumber }),
  ]);

  if (pos.length === 0 && grns.length === 0 && invoices.length === 0) {
    return res.status(404).json({
      success: false,
      message: `No documents found for PO number: ${poNumber}`,
    });
  }

  // Re-run matching to get the freshest result
  let matchResult;
  try {
    matchResult = await triggerMatching(poNumber);
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: `Matching error: ${err.message}`,
    });
  }

  // Build a rich response with linked document details
  const poDetails = pos.map((p) => ({
    id: p._id,
    poNumber: p.poNumber,
    poDate: p.poDate,
    vendorName: p.vendorName,
    totalAmount: p.totalAmount,
    itemCount: p.items.length,
    uploadedAt: p.uploadedAt,
  }));

  const grnDetails = grns.map((g) => ({
    id: g._id,
    grnNumber: g.grnNumber,
    grnDate: g.grnDate,
    itemCount: g.items.length,
    uploadedAt: g.uploadedAt,
  }));

  const invoiceDetails = invoices.map((i) => ({
    id: i._id,
    invoiceNumber: i.invoiceNumber,
    invoiceDate: i.invoiceDate,
    totalAmount: i.totalAmount,
    itemCount: i.items.length,
    uploadedAt: i.uploadedAt,
  }));

  return res.status(200).json({
    success: true,
    poNumber,
    matchStatus: matchResult.status,
    reasons: matchResult.reasons,
    summary: matchResult.summary,
    itemResults: matchResult.itemResults,
    documents: {
      purchaseOrders: poDetails,
      grns: grnDetails,
      invoices: invoiceDetails,
    },
    lastUpdated: matchResult.lastUpdated,
  });
};

// ─── GET /match ───────────────────────────────────────────────────────────────

const listAllMatches = async (req, res) => {
  const { status, page = 1, limit = 20 } = req.query;
  const filter = status ? { status } : {};
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [results, total] = await Promise.all([
    MatchResult.find(filter)
      .select('poNumber status reasons summary lastUpdated')
      .skip(skip)
      .limit(parseInt(limit))
      .sort({ lastUpdated: -1 }),
    MatchResult.countDocuments(filter),
  ]);

  return res.status(200).json({
    success: true,
    total,
    page: parseInt(page),
    limit: parseInt(limit),
    data: results,
  });
};

module.exports = { getMatchByPONumber, listAllMatches };
