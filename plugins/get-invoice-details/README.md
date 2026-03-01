# Get Invoice Details

A Claude Code plugin that extracts structured data from invoice documents. It reads invoices (text or PDF), pulls out key fields, and saves the result as JSON in your Roxabi vault.

## What it does

When you point it at an invoice, the plugin:

1. **Reads the document** — accepts text files, PDFs, or pasted content
2. **Extracts key fields** — vendor, invoice number, dates, amounts, line items, tax, payment terms, and status
3. **Saves structured JSON** to `~/.roxabi-vault/invoices/` (auto-creates the directory on first use)
4. **Indexes in vault** if the vault database is available (optional — works without it)
5. **Displays the results** so you can verify the extracted data

## Install

### From the Roxabi marketplace

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install get-invoice-details
```

## Usage

Run with any of these phrases in Claude Code:

- `get-invoice-details`
- `extract invoice`
- `parse invoice`
- `invoice details`
- `read invoice`

Then provide the path to your invoice file or paste the invoice content directly.

### Example

```
extract invoice ~/Documents/invoices/INV-2024-0042.pdf
```

The plugin extracts the details and saves them as:

```
~/.roxabi-vault/invoices/INV-2024-0042.json
```

## Output format

The extracted data follows a consistent JSON structure:

| Field | Description |
|-------|-------------|
| `vendor` | Company or person who issued the invoice |
| `invoice_number` | Unique invoice identifier |
| `date` | Invoice issue date (ISO 8601) |
| `due_date` | Payment due date (ISO 8601) |
| `currency` | Three-letter currency code |
| `subtotal` | Total before tax |
| `tax` | Tax amount |
| `total` | Final amount due |
| `line_items` | Array of items with description, quantity, unit price, and amount |
| `payment_terms` | Payment terms (e.g. "Net 30") |
| `status` | "pending", "paid", or "overdue" |

See `examples/invoice.example.json` for a complete example.

## How it works

The plugin uses a Python extraction script (`scripts/extract.py`) that reads invoice content and outputs structured JSON. For PDF files, it uses `pdftotext` (from poppler-utils) to extract text first.

The vault integration is optional. If `~/.roxabi-vault/vault.db` exists and is healthy, the invoice gets indexed there for cross-plugin search. If not, the JSON file is saved directly and the plugin works without any vault setup.

The invoices directory at `~/.roxabi-vault/invoices/` is created automatically on first use — no initialization step needed.

## License

MIT
