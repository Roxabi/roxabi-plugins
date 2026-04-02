---
name: get-invoice-details
description: 'Extract and store invoice details from documents — vendor, date, amount, line items, tax, payment terms. Saves structured JSON to vault. Triggers: "get-invoice-details" | "extract invoice" | "parse invoice" | "invoice details" | "read invoice".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob
---

# Get Invoice Details

Let:
  V := `~/.roxabi-vault/invoices`

**Goal:** Extract structured data from an invoice → store as JSON in V.

## Workflow

### Phase 1 — Accept Input

1. Accept invoice file path or pasted content via `$ARGUMENTS`.
2. Input ∄ → AskUserQuestion: "Provide the path to the invoice file or paste the invoice content."
3. Path given → verify file ∃.

### Phase 2 — Extract Details

1. Read invoice content. PDF → run extraction script:
```bash
python3 plugins/get-invoice-details/scripts/extract.py --input "<file_path>"
```
2. Extract fields: `vendor` | `invoice_number` | `date` (ISO 8601) | `due_date` (ISO 8601) | `currency` (3-letter) | `subtotal` | `tax` | `total` | `line_items` (array of `{description, quantity, unit_price, amount}`) | `payment_terms` | `status` ("pending" | "paid" | "overdue")

### Phase 3 — Save to Vault

1. Create V on first use:
```bash
mkdir -p -m 700 ~/.roxabi-vault/invoices
```
2. Save JSON → `V/<invoice_number>.json`.
3. `vault_healthy()` → index in vault database. ∄ → save JSON only, inform user.

### Phase 4 — Display Results

Display extracted details in readable format. Confirm save location. Report vault indexing status (indexed ∨ vault unavailable).

### Self-Check

- V created automatically — ¬manual init required
- Extraction script handles text ∧ PDF
- Vault indexing optional — plugin works without vault

$ARGUMENTS
