#!/usr/bin/env python3
"""serve.py — serve forge visuals with live-reload.

- Regenerates manifest.json on startup and whenever HTML files change
- Watches for HTML file changes (add/remove/modify) every 2s
- Pushes SSE events to connected browsers on change

Usage:
  FORGE_DIR=~/.roxabi/forge python3 serve.py
  FORGE_DIR=~/.roxabi/forge FORGE_PORT=9090 python3 serve.py
"""
import glob as globmod
import http.server, json, os, re, threading, time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DIR = Path(os.environ.get('FORGE_DIR', os.environ.get('DIAGRAMS_DIR', SCRIPT_DIR)))
PORT = int(os.environ.get('FORGE_PORT', os.environ.get('DIAGRAMS_PORT', 8080)))

META_RE = re.compile(r'<meta\s+name="diagram:([\w-]+)"\s+content="([^"]*)"', re.IGNORECASE)
TITLE_RE = re.compile(r'<title>([^<]+)</title>', re.IGNORECASE)
END_MARKER = '<!-- diagram-meta:end -->'

VALID_COLORS = {'amber', 'blue', 'green', 'purple', 'orange', 'cyan', 'red', 'gold'}


def normalize_color(color, filepath=''):
    """Map unknown color values (hex codes, typos) to valid CSS class names."""
    if color in VALID_COLORS:
        return color
    if not color:
        return 'blue'
    print(f'  ⚠ unknown color "{color}" in {filepath} — falling back to orange')
    return 'orange'

# ── Manifest generation (same logic as gen-manifest.py) ──────────

def parse_html(filepath):
    buf = ''
    try:
        with open(filepath, encoding='utf-8', errors='ignore') as f:
            for line in f:
                buf += line
                if END_MARKER in line:
                    break
                if '</head>' in line.lower():
                    break
                if len(buf) > 512 * 1024:
                    break
    except OSError:
        return None

    metas = dict(META_RE.findall(buf))

    # Fallback: extract <title> when diagram:title meta is missing
    if 'title' not in metas:
        m = TITLE_RE.search(buf)
        if not m:
            return None
        metas['title'] = m.group(1).strip()

    badges = [b.strip() for b in metas.get('badges', '').split(',') if b.strip()]
    kb = max(1, round(filepath.stat().st_size / 1024))

    # Infer category from path for symlinks without meta
    cat = metas.get('category', '')
    cat_label = metas.get('cat-label', '')
    color = metas.get('color', '')
    if not cat:
        name = filepath.name.lower()
        if '/brand/' in str(filepath):
            cat, cat_label, color = 'brand', 'Lyra Branding', 'purple'
        elif name.startswith('lyra-'):
            cat, cat_label, color = 'lyra', 'Lyra Docs', 'blue'
        elif name.startswith('ve-'):
            cat, cat_label, color = 've', 'Visual Explainer', 'purple'
        else:
            cat, cat_label, color = 'ext', 'External', 'green'
    color = normalize_color(color, filepath)

    # Infer date from file mtime when not in meta
    date = metas.get('date', '')
    if not date:
        date = time.strftime('%Y-%m-%d', time.localtime(filepath.stat().st_mtime))

    return {
        'f': filepath.name,
        't': metas['title'],
        'd': date,
        'kb': kb,
        'cat': cat,
        'cl': cat_label,
        'c': color,
        'b': badges,
    }


def gen_manifest():
    entries, skipped = [], []
    for match in sorted(globmod.glob(str(DIR / '**/*.html'), recursive=True)):
        fp = Path(match)
        rel = str(fp.relative_to(DIR))
        if fp.name == 'index.html' or '/tabs/' in rel or rel.startswith('tabs/') or rel.startswith('_dist/'):
            continue
        # Resolve symlinks for parsing, but keep relative path
        target = fp.resolve() if fp.is_symlink() else fp
        if not target.exists():
            skipped.append(rel + ' (broken link)')
            continue
        entry = parse_html(target)
        if entry:
            entry['f'] = rel
            entries.append(entry)
        else:
            skipped.append(rel)

    out = DIR / 'manifest.json'
    out.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + '\n')
    return entries, skipped


# ── File watcher ─────────────────────────────────────────────────

sse_clients = []          # list of wfile objects
sse_lock = threading.Lock()


def snapshot():
    """Return {relative_path: (mtime, size)} for all .html files, recursing into subdirs."""
    snap = {}
    for match in globmod.glob(str(DIR / '**/*.html'), recursive=True):
        fp = Path(match)
        rel = str(fp.relative_to(DIR))
        if fp.name == 'index.html' or '/tabs/' in rel or rel.startswith('tabs/') or rel.startswith('_dist/'):
            continue
        try:
            target = fp.resolve() if fp.is_symlink() else fp
            st = target.stat()
            snap[rel] = (st.st_mtime, st.st_size)
        except OSError:
            snap[rel] = (0, 0)
    return snap


def watcher_loop():
    prev = snapshot()
    while True:
        time.sleep(2)
        curr = snapshot()
        if curr != prev:
            added = set(curr) - set(prev)
            removed = set(prev) - set(curr)
            changed = {k for k in set(curr) & set(prev) if curr[k] != prev[k]}
            delta = added | removed | changed
            prev = curr

            entries, skipped = gen_manifest()
            print(f'[watcher] manifest updated — {len(entries)} diagrams (changed: {", ".join(sorted(delta))})')

            # Notify SSE clients
            msg = f'data: {json.dumps({"type":"reload","changed":sorted(delta)})}\n\n'
            with sse_lock:
                dead = []
                for wf in sse_clients:
                    try:
                        wf.write(msg.encode())
                        wf.flush()
                    except Exception:
                        dead.append(wf)
                for wf in dead:
                    sse_clients.remove(wf)


# ── HTTP handler ─────────────────────────────────────────────────

FAVICON_SVG = (
    b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    b'<rect width="32" height="32" rx="6" fill="#6366f1"/>'
    b'<path d="M8 22V10l8 6-8 6zm8 0V10l8 6-8 6z" fill="#fff" opacity=".9"/>'
    b'</svg>'
)


class Handler(http.server.SimpleHTTPRequestHandler):
    # Text assets we do NOT want browsers to cache — galleries, styles, scripts,
    # and data JSONs all change during active development. Images (png/jpg/webp)
    # and svgs keep default caching: they live at stable unique filenames and
    # are too large to re-fetch on every pageview.
    _NO_CACHE_EXTS = ('.html', '.htm', '.css', '.js', '.mjs', '.json')

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIR), **kwargs)

    def end_headers(self):
        # Inject Cache-Control: no-cache for dev-iteration assets before the
        # base class flushes the header buffer. Custom handlers above (favicon,
        # /api/list, /api/events) already set their own Cache-Control — they
        # short-circuit on the extension check anyway (.ico, no extension,
        # api path) so no duplicate header is emitted.
        path = self.path.split('?', 1)[0].split('#', 1)[0].lower()
        # `/` serves the dashboard index.html; treat it the same.
        if path == '/' or path.endswith(self._NO_CACHE_EXTS):
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def do_GET(self):
        # Serve gallery UI (index.html) from the script directory, not the data directory
        if self.path in ('/', '/index.html'):
            index = SCRIPT_DIR / 'index.html'
            body = index.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == '/favicon.ico':
            self.send_response(200)
            self.send_header('Content-Type', 'image/svg+xml')
            self.send_header('Content-Length', str(len(FAVICON_SVG)))
            self.send_header('Cache-Control', 'public, max-age=86400')
            self.end_headers()
            self.wfile.write(FAVICON_SVG)
            return

        if self.path.startswith('/api/list/'):
            self._handle_list()
            return

        if self.path == '/api/events':
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Connection', 'keep-alive')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            # Send initial heartbeat
            self.wfile.write(b': connected\n\n')
            self.wfile.flush()
            with sse_lock:
                sse_clients.append(self.wfile)
            # Keep connection open
            try:
                while True:
                    time.sleep(30)
                    self.wfile.write(b': ping\n\n')
                    self.wfile.flush()
            except Exception:
                pass
            finally:
                with sse_lock:
                    if self.wfile in sse_clients:
                        sse_clients.remove(self.wfile)
            return

        super().do_GET()

    def _handle_list(self):
        """GET /api/list/<path> — return JSON directory listing.

        Returns [{name, size, mtime}] for files in the requested directory.
        Only serves paths under DIR (no traversal). Follows symlinks.
        """
        import urllib.parse
        rel = urllib.parse.unquote(self.path[len('/api/list/'):]).strip('/')

        # Prevent directory traversal — verify the unresolved path stays under DIR
        # (symlinks within DIR are allowed, so we check before resolving)
        candidate = DIR / rel
        try:
            # Ensure no '..' escapes above DIR
            candidate.relative_to(DIR)
        except ValueError:
            self.send_error(403, 'Forbidden')
            return

        # Resolve symlinks for actual access
        target = candidate.resolve()
        if not target.is_dir():
            self.send_error(404, 'Not a directory')
            return

        entries = []
        for child in sorted(target.iterdir()):
            if child.name.startswith('.'):
                continue
            try:
                st = child.stat()
                entries.append({
                    'name': child.name,
                    'size': st.st_size,
                    'mtime': int(st.st_mtime),
                    'is_dir': child.is_dir(),
                })
            except OSError:
                continue

        body = json.dumps(entries, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Suppress noisy logs for SSE and manifest polling
        if '/api/events' in (str(args[0]) if args else ''):
            return
        super().log_message(fmt, *args)


# ── Main ─────────────────────────────────────────────────────────

if __name__ == '__main__':
    # Initial manifest generation
    entries, skipped = gen_manifest()
    print(f'manifest.json — {len(entries)} diagrams')
    if skipped:
        print(f'  skipped (no meta): {", ".join(skipped)}')

    # Start file watcher
    t = threading.Thread(target=watcher_loop, daemon=True)
    t.start()

    # Start HTTP server
    server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print(f'Serving diagrams at http://localhost:{PORT}')
    print(f'Watching for changes every 2s...')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
