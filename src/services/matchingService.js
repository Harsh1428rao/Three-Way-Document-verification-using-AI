const PurchaseOrder = require('../models/PurchaseOrder');
const GRN = require('../models/GRN');
const Invoice = require('../models/Invoice');
const MatchResult = require('../models/MatchResult');

// ─── Item Key Normalization ───────────────────────────────────────────────────
/**
 * ITEM MATCHING KEY STRATEGY
 * Priority: itemCode > sku > normalized_description
 *
 * Rationale: itemCode/sku are authoritative machine-readable identifiers
 * and are the most reliable keys across PO, GRN, and Invoice documents.
 * When both are absent (e.g. free-text documents), we normalize the
 * description to lowercase + trimmed + single-space for fuzzy matching.
 * This is a best-effort fallback; real-world implementations would use
 * embedding similarity or a product catalog lookup.
 */
function normalizeItemKey(item) {
  if (item.itemCode && item.itemCode.trim() !== '') {
    return item.itemCode.trim().toUpperCase();
  }
  if (item.sku && item.sku.trim() !== '') {
    return item.sku.trim().toUpperCase();
  }
  // Fallback: normalize description
  return (item.description || 'UNKNOWN')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// ─── Core Matching Logic ──────────────────────────────────────────────────────

async function performMatching(poNumber) {
  // Fetch all related documents
  const [pos, grns, invoices] = await Promise.all([
    PurchaseOrder.find({ poNumber }),
    GRN.find({ poNumber }),
    Invoice.find({ poNumber }),
  ]);

  const reasons = [];
  const itemResults = [];

  // ── Insufficient documents check ──────────────────────────────────────────
  if (pos.length === 0 && grns.length === 0 && invoices.length === 0) {
    return buildResult(poNumber, 'insufficient_documents', [], [], [], [], [
      'no_documents_found',
    ]);
  }

  // ── Duplicate PO check ────────────────────────────────────────────────────
  if (pos.length > 1) {
    reasons.push('duplicate_po');
    return buildResult(
      poNumber,
      'mismatch',
      pos,
      grns,
      invoices,
      [],
      reasons
    );
  }

  const po = pos[0] || null;

  if (!po) {
    // Documents exist but PO hasn't arrived yet (out-of-order)
    return buildResult(
      poNumber,
      'insufficient_documents',
      [],
      grns,
      invoices,
      [],
      ['po_not_yet_received']
    );
  }

  if (grns.length === 0) {
    return buildResult(poNumber, 'insufficient_documents', [po], [], invoices, [], [
      'no_grn_received',
    ]);
  }

  if (invoices.length === 0) {
    return buildResult(poNumber, 'insufficient_documents', [po], grns, [], [], [
      'no_invoice_received',
    ]);
  }

  // ── Build PO items map ────────────────────────────────────────────────────
  const poItemsMap = {};
  for (const item of po.items) {
    const key = normalizeItemKey(item);
    poItemsMap[key] = { ...item.toObject(), quantity: Number(item.quantity) };
  }

  // ── Aggregate GRN quantities per item ─────────────────────────────────────
  const grnQtyMap = {};
  for (const grn of grns) {
    for (const item of grn.items) {
      const key = normalizeItemKey(item);
      grnQtyMap[key] = (grnQtyMap[key] || 0) + Number(item.receivedQuantity);
    }
  }

  // ── Aggregate Invoice quantities per item + date check ────────────────────
  const invoiceQtyMap = {};
  for (const invoice of invoices) {
    // Rule 4: Invoice date must not be after PO date
    if (po.poDate && invoice.invoiceDate) {
      const poDateMs = new Date(po.poDate).getTime();
      const invDateMs = new Date(invoice.invoiceDate).getTime();
      if (invDateMs > poDateMs) {
        reasons.push(
          `invoice_date_after_po_date [invoice: ${invoice.invoiceNumber}]`
        );
      }
    }
    for (const item of invoice.items) {
      const key = normalizeItemKey(item);
      invoiceQtyMap[key] = (invoiceQtyMap[key] || 0) + Number(item.quantity);
    }
  }

  // ── Per-item validation ───────────────────────────────────────────────────

  // Check items from PO
  for (const [key, poItem] of Object.entries(poItemsMap)) {
    const poQty = poItem.quantity;
    const grnQty = grnQtyMap[key] || 0;
    const invoiceQty = invoiceQtyMap[key] || 0;

    const issues = [];

    // Rule 1: GRN qty must not exceed PO qty
    if (grnQty > poQty) {
      issues.push('grn_qty_exceeds_po_qty');
      reasons.push(`grn_qty_exceeds_po_qty [item: ${key}] grn=${grnQty} po=${poQty}`);
    }

    // Rule 2: Invoice qty must not exceed PO qty
    if (invoiceQty > poQty) {
      issues.push('invoice_qty_exceeds_po_qty');
      reasons.push(
        `invoice_qty_exceeds_po_qty [item: ${key}] invoice=${invoiceQty} po=${poQty}`
      );
    }

    // Rule 3: Invoice qty must not exceed total GRN qty
    if (grnQty > 0 && invoiceQty > grnQty) {
      issues.push('invoice_qty_exceeds_grn_qty');
      reasons.push(
        `invoice_qty_exceeds_grn_qty [item: ${key}] invoice=${invoiceQty} grn=${grnQty}`
      );
    }

    itemResults.push({
      itemKey: key,
      description: poItem.description,
      poQuantity: poQty,
      grnQuantity: grnQty,
      invoiceQuantity: invoiceQty,
      status: issues.length === 0 ? 'matched' : 'mismatch',
      issues,
    });
  }

  // Check items in GRN/Invoice that are NOT in PO
  const allReceivedKeys = new Set([
    ...Object.keys(grnQtyMap),
    ...Object.keys(invoiceQtyMap),
  ]);

  for (const key of allReceivedKeys) {
    if (!poItemsMap[key]) {
      reasons.push(`item_missing_in_po [item: ${key}]`);
      itemResults.push({
        itemKey: key,
        description: key,
        poQuantity: 0,
        grnQuantity: grnQtyMap[key] || 0,
        invoiceQuantity: invoiceQtyMap[key] || 0,
        status: 'mismatch',
        issues: ['item_missing_in_po'],
      });
    }
  }

  // ── Determine overall status ──────────────────────────────────────────────
  const dateReasons = reasons.filter((r) =>
    r.startsWith('invoice_date_after_po_date')
  );
  const itemMismatches = itemResults.filter((r) => r.status === 'mismatch');

  let status;
  if (reasons.length === 0) {
    status = 'matched';
  } else if (
    itemMismatches.length > 0 &&
    itemMismatches.length === itemResults.length
  ) {
    status = 'mismatch';
  } else {
    status = 'partially_matched';
  }

  return buildResult(poNumber, status, [po], grns, invoices, itemResults, reasons);
}

// ─── Helper to build and persist MatchResult ─────────────────────────────────

async function buildResult(poNumber, status, pos, grns, invoices, itemResults, reasons) {
  const po = pos[0] || null;

  const summary = {
    totalPOItems: itemResults.length,
    matchedItems: itemResults.filter((i) => i.status === 'matched').length,
    mismatchedItems: itemResults.filter((i) => i.status === 'mismatch').length,
    totalGRNs: grns.length,
    totalInvoices: invoices.length,
  };

  const matchData = {
    poNumber,
    status,
    po: po ? po._id : null,
    grns: grns.map((g) => g._id),
    invoices: invoices.map((i) => i._id),
    itemResults,
    reasons,
    summary,
    lastUpdated: new Date(),
  };

  // Upsert the match result
  const matchResult = await MatchResult.findOneAndUpdate(
    { poNumber },
    { $set: matchData },
    { upsert: true, new: true }
  );

  return matchResult;
}

// ─── Trigger matching after document upload ───────────────────────────────────

async function triggerMatching(poNumber) {
  try {
    const result = await performMatching(poNumber);
    console.log(
      `🔄 Match triggered for PO ${poNumber} → Status: ${result.status}`
    );
    return result;
  } catch (error) {
    console.error(`❌ Matching error for PO ${poNumber}:`, error.message);
    throw error;
  }
}

module.exports = { triggerMatching, performMatching };
