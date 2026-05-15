const mongoose = require('mongoose');

const InvoiceItemSchema = new mongoose.Schema({
  itemCode: { type: String, default: null },
  sku: { type: String, default: null },
  description: { type: String, required: true },
  quantity: { type: Number, required: true },
  unitPrice: { type: Number, default: null },
  totalPrice: { type: Number, default: null },
  unit: { type: String, default: null },
}, { _id: false });

const InvoiceSchema = new mongoose.Schema({
  documentId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  invoiceNumber: {
    type: String,
    required: true,
  },
  poNumber: {
    type: String,
    required: true,
    index: true,
  },
  invoiceDate: { type: Date, default: null },
  vendorName: { type: String, default: null },
  vendorAddress: { type: String, default: null },
  buyerName: { type: String, default: null },
  currency: { type: String, default: 'USD' },
  totalAmount: { type: Number, default: null },
  taxAmount: { type: Number, default: null },
  items: [InvoiceItemSchema],
  filePath: { type: String, required: true },
  originalFileName: { type: String },
  mimeType: { type: String },
  rawExtractedText: { type: String, default: null },
  uploadedAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('Invoice', InvoiceSchema);
