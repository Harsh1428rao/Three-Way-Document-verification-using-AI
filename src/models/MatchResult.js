const mongoose = require('mongoose');

const ItemMatchResultSchema = new mongoose.Schema({
  itemKey: { type: String },
  description: { type: String },
  poQuantity: { type: Number, default: 0 },
  grnQuantity: { type: Number, default: 0 },
  invoiceQuantity: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['matched', 'mismatch', 'warning'],
    default: 'matched',
  },
  issues: [{ type: String }],
}, { _id: false });

const MatchResultSchema = new mongoose.Schema({
  poNumber: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['matched', 'partially_matched', 'mismatch', 'insufficient_documents'],
    default: 'insufficient_documents',
  },
  po: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PurchaseOrder',
    default: null,
  },
  grns: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GRN',
  }],
  invoices: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
  }],
  itemResults: [ItemMatchResultSchema],
  reasons: [{ type: String }],
  summary: {
    totalPOItems: { type: Number, default: 0 },
    matchedItems: { type: Number, default: 0 },
    mismatchedItems: { type: Number, default: 0 },
    totalGRNs: { type: Number, default: 0 },
    totalInvoices: { type: Number, default: 0 },
  },
  lastUpdated: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('MatchResult', MatchResultSchema);
