# Three-Way Match Engine

A backend service that allows users to upload Purchase Order (PO), Goods Receipt Note (GRN), and Invoice documents, extract structured data using **Gemini API**, store the extracted data in **MongoDB**, and perform a **three-way match** with full out-of-order document support.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Approach](#approach)
- [Data Model](#data-model)
- [Parsing Flow](#parsing-flow)
- [Matching Logic](#matching-logic)
- [Out-of-Order Uploads](#out-of-order-uploads)
- [API Reference](#api-reference)
- [Item Matching Key](#item-matching-key)
- [Assumptions & Tradeoffs](#assumptions--tradeoffs)
- [What I Would Improve](#what-i-would-improve)

---

## Quick Start

### Prerequisites
- Node.js 18+
- MongoDB (local or Atlas)
- Gemini API key ([get one free](https://aistudio.google.com/app/apikey))

### Setup

```bash
# 1. Clone and install
git clone <your-repo-url>
cd three-way-match-engine
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env: set MONGODB_URI and GEMINI_API_KEY

# 3. Start the server
npm run dev      # development (nodemon)
npm start        # production
```

Server runs at `http://localhost:3000`

### Test It

```bash
# Health check
curl http://localhost:3000/health

# Upload a PO
curl -X POST http://localhost:3000/documents/upload \
  -F "file=@/path/to/po.pdf" \
  -F "documentType=po"

# Get match result
curl http://localhost:3000/match/PO-2024-0042
```

---

## Approach

The system follows a **parse-store-match** pipeline:

1. **Upload**: File received via multipart form upload (Multer)
2. **Parse**: Gemini 1.5 Flash extracts structured JSON from the document
3. **Store**: Parsed data persisted in MongoDB (separate collections per doc type)
4. **Match**: Matching triggered automatically; result upserted in `matchresults` collection
5. **Query**: Match results always reflect the latest document state

---

## Data Model

### PurchaseOrder
```json
{
  "documentId": "uuid",
  "poNumber": "PO-2024-0042",
  "poDate": "2024-06-01",
  "vendorName": "TechSupply Co.",
  "currency": "INR",
  "totalAmount": 185000,
  "items": [
    { "itemCode": "ITEM-001", "sku": "TSC-LAPTOP-15", "description": "...", "quantity": 10, "unitPrice": 75000 }
  ]
}
```

### GRN
```json
{
  "documentId": "uuid",
  "grnNumber": "GRN-2024-0101",
  "poNumber": "PO-2024-0042",
  "grnDate": "2024-06-10",
  "items": [
    { "itemCode": "ITEM-001", "description": "...", "receivedQuantity": 7 }
  ]
}
```

### Invoice
```json
{
  "documentId": "uuid",
  "invoiceNumber": "INV-TS-2024",
  "poNumber": "PO-2024-0042",
  "invoiceDate": "2024-06-12",
  "items": [
    { "itemCode": "ITEM-001", "description": "...", "quantity": 7, "unitPrice": 75000 }
  ]
}
```

### MatchResult
```json
{
  "poNumber": "PO-2024-0042",
  "status": "matched | partially_matched | mismatch | insufficient_documents",
  "reasons": [],
  "itemResults": [...],
  "summary": { "totalPOItems": 3, "matchedItems": 3, "mismatchedItems": 0, ... }
}
```

---

## Parsing Flow

```
Upload File → Multer (disk storage)
     ↓
Gemini 1.5 Flash (inline base64 + structured prompt)
     ↓
JSON response → clean (strip markdown fences)
     ↓
Parse JSON → retry if malformed
     ↓
Save to MongoDB (PurchaseOrder / GRN / Invoice)
     ↓
Trigger matching by poNumber
```

**Document-type prompts** instruct Gemini to return only a plain JSON object with the exact schema required. If the first attempt returns malformed JSON, a follow-up prompt asks Gemini to fix it.

**Supported file types**: PDF, JPEG, PNG, WEBP, TXT (up to 20MB)

---

## Matching Logic

Matching runs every time a document is uploaded for a `poNumber`.

### Rules (applied at item level)

| Rule | Reason Code |
|------|-------------|
| GRN quantity > PO quantity | `grn_qty_exceeds_po_qty` |
| Invoice quantity > PO quantity | `invoice_qty_exceeds_po_qty` |
| Invoice quantity > total GRN quantity | `invoice_qty_exceeds_grn_qty` |
| Invoice date > PO date | `invoice_date_after_po_date` |
| Item in GRN/Invoice not in PO | `item_missing_in_po` |
| More than one PO with same number | `duplicate_po` |

### Status Determination

| Condition | Status |
|-----------|--------|
| PO/GRN/Invoice missing | `insufficient_documents` |
| All item rules pass, no date issues | `matched` |
| Some items match, some don't | `partially_matched` |
| All items have mismatches | `mismatch` |

### Multiple GRNs / Invoices

- GRN quantities are **summed** across all GRNs for a poNumber before comparison
- Invoice quantities are **summed** across all Invoices for a poNumber

---

## Out-of-Order Uploads

The system handles any upload order:

- Every document is **stored immediately** after parsing, regardless of whether related documents exist
- Matching is **triggered on every upload** for the associated `poNumber`
- If the PO hasn't arrived yet, status is `insufficient_documents` with reason `po_not_yet_received`
- When the PO finally arrives, matching re-runs and the result is updated

**Example — Invoice arrives before PO:**
1. Invoice uploaded → stored, matching triggered → `insufficient_documents` (po_not_yet_received)
2. GRN uploaded → stored, matching triggered → `insufficient_documents` (po_not_yet_received)
3. PO uploaded → stored, matching triggered → **actual match result computed and stored**

---

## Item Matching Key

**Priority:** `itemCode` → `sku` → normalized `description`

**Rationale:**
- `itemCode` is a machine-assigned, deterministic identifier present in most procurement systems. It is the most reliable cross-document key.
- `sku` (Stock Keeping Unit) serves the same purpose when itemCode is absent.
- `description` normalized to `lowercase + trimmed + single-space` is a last-resort fallback for free-text documents. It is less reliable but covers edge cases where codes are not present.

This is explained in `src/services/matchingService.js` in the `normalizeItemKey()` function.

---

## API Reference

### POST /documents/upload
Upload and parse a document.

**Body (multipart/form-data):**
- `file` — PDF, image, or text file
- `documentType` — `po` | `grn` | `invoice`

**Response:**
```json
{
  "success": true,
  "document": { "id": "...", "documentId": "...", "poNumber": "..." },
  "parsedData": { ... },
  "matchStatus": { "poNumber": "PO-...", "status": "insufficient_documents" }
}
```

### GET /documents/:id
Get a parsed document by its MongoDB `_id`.

### GET /documents
List all documents. Query params: `poNumber`, `type`, `page`, `limit`.

### GET /match/:poNumber
Get three-way match result for a PO number.

**Response:**
```json
{
  "success": true,
  "poNumber": "PO-2024-0042",
  "matchStatus": "matched",
  "reasons": [],
  "summary": { "totalPOItems": 3, "matchedItems": 3 },
  "itemResults": [...],
  "documents": { "purchaseOrders": [...], "grns": [...], "invoices": [...] }
}
```

### GET /match
List all match results. Query params: `status`, `page`, `limit`.

---

## Assumptions & Tradeoffs

| Assumption | Reasoning |
|-----------|-----------|
| One PO per `poNumber` | Assignment spec; duplicates flagged as errors |
| Gemini has good enough OCR | Works well for clean PDF/images; handwritten docs may degrade |
| `poNumber` is present in all documents | Required field; fallback to `UNKNOWN-PO` if absent |
| Quantities are numeric in source docs | Gemini is instructed to cast to number |
| Partial GRN delivery is valid | GRN qty can be less than PO qty and still be `matched` |
| No authentication | Out of scope for this assignment |
| No retry queue for Gemini failures | File saved; parse would need re-upload |

---

## What I Would Improve With More Time

1. **Job queue (BullMQ/Redis)** — Decouple parsing from the HTTP response; handle retries on Gemini timeouts
2. **Authentication** — JWT-based auth with role-based access (finance vs. warehouse roles)
3. **Webhook / event bus** — Emit events when match status changes so downstream systems (ERP, Slack) are notified
4. **Unit & integration tests** — Jest tests for matching logic and API endpoints
5. **Rate limiting** — Protect Gemini API key from excessive usage
6. **Embedding-based item matching** — Use vector similarity for description matching instead of string normalization
7. **Audit trail** — Immutable log of all match state changes per poNumber
8. **Swagger UI** — Auto-generated API docs served at `/api-docs`
9. **Currency normalization** — Convert all amounts to a base currency before comparison
10. **Soft deletes** — Mark documents as inactive instead of hard deleting

---

## Project Structure

```
three-way-match-engine/
├── src/
│   ├── app.js                    # Express entry point
│   ├── config/db.js              # MongoDB connection
│   ├── controllers/
│   │   ├── documentController.js # Upload, list, get document
│   │   └── matchController.js    # Get match results
│   ├── middleware/upload.js       # Multer config
│   ├── models/
│   │   ├── PurchaseOrder.js
│   │   ├── GRN.js
│   │   ├── Invoice.js
│   │   └── MatchResult.js
│   ├── routes/
│   │   ├── documentRoutes.js
│   │   └── matchRoutes.js
│   └── services/
│       ├── geminiService.js      # Gemini API parsing
│       └── matchingService.js    # Three-way match logic
├── sample-data/                  # Example parsed outputs
├── postman/                      # Postman collection
├── uploads/                      # File storage (gitignored)
├── .env.example
├── package.json
└── README.md
```
