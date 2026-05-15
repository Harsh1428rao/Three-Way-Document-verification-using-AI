const mongoose = require('mongoose');

const GRNItemSchema = new mongoose.Schema({
  itemCode: { type: String, default: null },
  sku: { type: String, default: null },
  description: { type: String, required: true },
  receivedQuantity: { type: Number, required: true },
  unit: { type: String, default: null },
  condition: { type: String, default: null },
}, { _id: false });

const GRNSchema = new mongoose.Schema({
  documentId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  grnNumber: {
    type: String,
    required: true,
  },
  poNumber: {
    type: String,
    required: true,
    index: true,
  },
  grnDate: { type: Date, default: null },
  receivedBy: { type: String, default: null },
  warehouse: { type: String, default: null },
  items: [GRNItemSchema],
  filePath: { type: String, required: true },
  originalFileName: { type: String },
  mimeType: { type: String },
  rawExtractedText: { type: String, default: null },
  uploadedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('GRN', GRNSchema);
