#!/usr/bin/env python3
"""Extract invoice details from a document and save as structured JSON."""
import argparse
import json
import sys
from pathlib import Path

from _lib.paths import get_plugin_data, get_vault_home, ensure_dir, vault_healthy


PLUGIN_NAME = 'invoices'


def read_content(input_path: Path) -> str:
    """Read invoice content from a file. Supports text and PDF."""
    suffix = input_path.suffix.lower()
    if suffix == '.pdf':
        try:
            import subprocess
            result = subprocess.run(
                ['pdftotext', str(input_path), '-'],
                capture_output=True, text=True, check=True
            )
            return result.stdout
        except FileNotFoundError:
            print('Warning: pdftotext not found. Install poppler-utils for PDF support.', file=sys.stderr)
            print('Falling back to raw read.', file=sys.stderr)
    return input_path.read_text(encoding='utf-8')


def extract_fields(content: str) -> dict:
    """Parse invoice content and return structured data.

    Returns a template dict. When invoked from the SKILL.md workflow,
    Claude fills in actual values from the document content.
    """
    return {
        'vendor': '',
        'invoice_number': '',
        'date': '',
        'due_date': '',
        'currency': 'USD',
        'subtotal': 0.0,
        'tax': 0.0,
        'total': 0.0,
        'line_items': [],
        'payment_terms': '',
        'status': 'pending',
        '_raw_length': len(content),
    }


def save_invoice(data: dict, output_dir: Path) -> Path:
    """Save invoice JSON to output directory. Returns the file path."""
    ensure_dir(output_dir)
    invoice_id = data.get('invoice_number', 'unknown').replace('/', '-')
    out_file = output_dir / f'{invoice_id}.json'
    out_file.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    return out_file


def index_in_vault(data: dict) -> bool:
    """Index invoice in vault if available. Returns True on success."""
    if not vault_healthy():
        return False
    try:
        import sqlite3
        db_path = get_vault_home() / 'vault.db'
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute(
                'INSERT INTO entries (category, type, title, content, metadata) '
                'VALUES (?, ?, ?, ?, ?)',
                ('invoices', 'invoice', data.get('invoice_number', ''),
                 json.dumps(data), '{}')
            )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser(description='Extract invoice details from a document.')
    parser.add_argument('--input', required=True, help='Path to the invoice file.')
    parser.add_argument('--output', default=None, help='Output directory (default: ~/.roxabi-vault/invoices/).')
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.exists():
        print(f'Error: file not found: {input_path}', file=sys.stderr)
        sys.exit(1)

    output_dir = Path(args.output) if args.output else get_plugin_data(PLUGIN_NAME)

    content = read_content(input_path)
    data = extract_fields(content)

    out_file = save_invoice(data, output_dir)
    print(f'Saved: {out_file}')

    if index_in_vault(data):
        print('Indexed in vault.')
    else:
        print('Vault unavailable — skipped indexing.')


if __name__ == '__main__':
    main()
