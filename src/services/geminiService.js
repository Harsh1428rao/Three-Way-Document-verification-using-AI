const { Mistral } = require('@mistralai/mistralai');
const fs = require('fs');
const path = require('path');

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

// ─── Models ───────────────────────────────────────────────────────────────────
const OCR_MODEL  = 'mistral-ocr-latest';     // PDF + image OCR
const TEXT_MODEL = 'mistral-small-latest';   // JSON extraction from OCR output

// ─── Prompts ──────────────────────────────────────────────────────────────────
const PO_PROMPT = `You are a document parser. Extract structured data from this Purchase Order text.
Return ONLY a valid JSON object (no markdown, no code blocks, no explanation):

{
  "poNumber": "string (required)",
  "poDate": "YYYY-MM-DD or null",
  "vendorName": "string or null",
  "vendorAddress": "string or null",
  "buyerName": "string or null",
  "currency": "string or null",
  "totalAmount": number or null,
  "items": [
    {
      "itemCode": "string or null",
      "sku": "string or null",
      "description": "string (required)",
      "quantity": number (required),
      "unitPrice": number or null,
      "unit": "string or null"
    }
  ]
}
Rules: poNumber mandatory, quantities must be numbers, dates in YYYY-MM-DD, extract ALL line items.`;

const GRN_PROMPT = `You are a document parser. Extract structured data from this GRN document text.
Return ONLY a valid JSON object (no markdown, no code blocks, no explanation):

{
  "grnNumber": "string (required)",
  "poNumber": "string (required)",
  "grnDate": "YYYY-MM-DD or null",
  "receivedBy": "string or null",
  "warehouse": "string or null",
  "items": [
    {
      "itemCode": "string or null",
      "sku": "string or null",
      "description": "string (required)",
      "receivedQuantity": number (required),
      "unit": "string or null",
      "condition": "string or null"
    }
  ]
}
Rules: grnNumber and poNumber mandatory. Use SKU Code column as itemCode.
receivedQuantity = Recv Qty column NOT expected qty. Extract ALL line items.`;

const INVOICE_PROMPT = `You are a document parser. Extract structured data from this Invoice text.
Return ONLY a valid JSON object (no markdown, no code blocks, no explanation):

{
  "invoiceNumber": "string (required)",
  "poNumber": "string (required)",
  "invoiceDate": "YYYY-MM-DD or null",
  "vendorName": "string or null",
  "vendorAddress": "string or null",
  "buyerName": "string or null",
  "currency": "string or null",
  "totalAmount": number or null,
  "taxAmount": number or null,
  "items": [
    {
      "itemCode": "string or null",
      "sku": "string or null",
      "description": "string (required)",
      "quantity": number (required),
      "unitPrice": number or null,
      "totalPrice": number or null,
      "unit": "string or null"
    }
  ]
}
Rules: invoiceNumber and poNumber mandatory. Extract ALL line items.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPrompt(documentType) {
  switch (documentType.toLowerCase()) {
    case 'po':      return PO_PROMPT;
    case 'grn':     return GRN_PROMPT;
    case 'invoice': return INVOICE_PROMPT;
    default: throw new Error(`Unknown document type: ${documentType}`);
  }
}

function cleanAndParseJSON(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.pdf':  'application/pdf',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
    '.webp': 'image/webp',
  };
  return map[ext] || 'application/pdf';
}

// ─── Step 1: OCR the document via Mistral OCR API ─────────────────────────────

async function extractTextWithMistralOCR(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const base64Data = fileBuffer.toString('base64');
  const mimeType   = getMimeType(filePath);
  const ext        = path.extname(filePath).toLowerCase();
  const isPDF      = ext === '.pdf';

  console.log(`🔍 Running Mistral OCR on: ${path.basename(filePath)}`);

  const ocrResponse = await client.ocr.process({
    model: OCR_MODEL,
    document: isPDF
      ? {
          type: 'document_url',
          documentUrl: `data:${mimeType};base64,${base64Data}`,
        }
      : {
          type: 'image_url',
          imageUrl: `data:${mimeType};base64,${base64Data}`,
        },
    includeImageBase64: false,
  });

  // Combine all pages into one text block
  const fullText = ocrResponse.pages
    .map((page) => page.markdown || page.text || '')
    .join('\n\n');

  return fullText;
}

// ─── Step 2: Extract structured JSON via Mistral chat model ──────────────────

async function extractJSONFromText(ocrText, documentType) {
  const prompt = getPrompt(documentType);

  console.log(`🤖 Extracting JSON for document type: ${documentType}`);

  const response = await client.chat.complete({
    model: TEXT_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You are a precise document data extractor. Always respond with valid JSON only. No markdown fences, no explanation, no extra text.',
      },
      {
        role: 'user',
        content: `${prompt}\n\nDocument content:\n\n${ocrText}`,
      },
    ],
    temperature: 0,
    maxTokens: 4096,
  });

  return response.choices[0].message.content;
}

// ─── Main Parse Function (same signature as before) ───────────────────────────

async function parseDocumentWithGemini(filePath, documentType, mimeType) {
  // Step 1: OCR
  let ocrText;
  try {
    ocrText = await extractTextWithMistralOCR(filePath);
  } catch (ocrError) {
    throw new Error(`Mistral OCR failed: ${ocrError.message}`);
  }

  if (!ocrText || ocrText.trim().length < 20) {
    throw new Error('OCR returned empty content. Please check the file.');
  }

  // Step 2: JSON extraction
  let rawText;
  try {
    rawText = await extractJSONFromText(ocrText, documentType);
  } catch (llmError) {
    throw new Error(`Mistral JSON extraction failed: ${llmError.message}`);
  }

  // Step 3: Parse JSON
  let parsed;
  try {
    parsed = cleanAndParseJSON(rawText);
  } catch (parseError) {
    // Retry with fix prompt
    console.warn('⚠️  JSON parse failed, retrying with fix prompt...');
    try {
      const fixResponse = await client.chat.complete({
        model: TEXT_MODEL,
        messages: [
          {
            role: 'user',
            content: `Fix this so it is valid JSON only. No markdown, no explanation:\n\n${rawText}`,
          },
        ],
        temperature: 0,
        maxTokens: 4096,
      });
      rawText = fixResponse.choices[0].message.content;
      parsed  = cleanAndParseJSON(rawText);
    } catch (retryError) {
      throw new Error(`Could not parse response into valid JSON: ${retryError.message}`);
    }
  }

  return { parsed, rawText };
}

module.exports = { parseDocumentWithGemini };