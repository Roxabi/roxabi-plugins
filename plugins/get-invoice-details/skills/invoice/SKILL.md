---
name: get-invoice-details
description: 'Extract and store invoice details from documents — vendor, date, amount, line items, tax, payment terms. Saves structured JSON to vault. Triggers: "get-invoice-details" | "extract invoice" | "parse invoice" | "invoice details" | "read invoice".'
version: 0.1.0
allowed-tools: Read, Write, Bash, Glob
---

# Get Invoice Details

**Goal:** Extract structured data from an invoice document and store it as JSON in `~/.roxabi-vault/invoices/`.

## Workflow

### Phase 1 — Accept Input

1. Accept invoice file path or pasted content from the user via `$ARGUMENTS`.
2. If no input provided, AskUserQuestion: "Provide the path to the invoice file or paste the invoice content."
3. Verify the file exists (if a path was given).

### Phase 2 — Extract Details

1. Read the invoice content. For PDF files, run the extraction script:
```bash
python3 plugins/get-invoice-details/scripts/extract.py --input "<file_path>"
```
2. Extract the following fields:
   - `vendor` — company or person who issued the invoice
   - `invoice_number` — unique invoice identifier
   - `date` — invoice issue date (ISO 8601)
   - `due_date` — payment due date (ISO 8601)
   - `currency` — three-letter currency code
   - `subtotal` — total before tax
   - `tax` — tax amount
   - `total` — final amount due
   - `line_items` — array of `{description, quantity, unit_price, amount}`
   - `payment_terms` — payment terms (e.g. "Net 30")
   - `status` — "pending", "paid", or "overdue"

### Phase 3 — Save to Vault

1. Auto-create the invoices directory on first use:
```bash
mkdir -p -m 700 ~/.roxabi-vault/invoices
```
2. Save the structured JSON to `~/.roxabi-vault/invoices/<invoice_number>.json`.
3. If `vault_healthy()`, index the result in the vault database.
4. Graceful fallback: if vault is unavailable, save the JSON file only and inform the user.

### Phase 4 — Display Results

1. Display the extracted invoice details to the user in a readable format.
2. Confirm the save location.
3. Report vault indexing status (indexed / vault unavailable).

### Self-Check

- Directory `~/.roxabi-vault/invoices/` is created automatically — no manual init required.
- The extraction script handles text and PDF input.
- Vault indexing is optional — the plugin works without a vault.

$ARGUMENTS
