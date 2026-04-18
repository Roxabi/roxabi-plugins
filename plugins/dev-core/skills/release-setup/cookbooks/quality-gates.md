# Cookbook — Quality Gates

Let:
  F    := `--force` flag present in `$ARGUMENTS`
  σ    := `.claude/stack.yml`
  PRJ  := `${CLAUDE_PLUGIN_ROOT}/tools/`   # canonical source of truth for shell scripts
  D✅(label) := Display: `{label} ✅ Configured`
  D⏭(label)  := Display: `{label} ⏭ Already configured`
  D⚠(label)  := Display: `{label} ⚠️ {detail}`

## Phase 4.5 — Quality Gates

Python code-hygiene contracts: file-length guard, folder-size guard, import-layer enforcement.

## N1 — Entry guard

Parse σ. Emit D⏭("Quality gates — Skipped") and return immediately if ANY of:

- `runtime` != `python`
- `quality_gates:` key absent from σ
- All three sub-blocks (`file_length`, `folder_size`, `import_layers`) either absent or each has `enabled: false`

If `quality_gates:` is present and at least one sub-block is `enabled: true`, continue to N2.

Special case: all three sub-blocks present but each `enabled: false` → emit
`Quality gates ⏭ All gates disabled` and return (D6 — no install, no removal).

## N2 — Canonical source check

```bash
test -x "${PRJ}check_file_length.sh" && test -x "${PRJ}check_folder_size.sh"
```

If either canonical script is missing or not executable:
- D⚠("Quality gates — canonical scripts missing from ${PRJ}. Cookbook cannot proceed.")
- Abort this cookbook (return to release-setup Phase 5 with gate status = error).

## N3 — Script install and drift detection

Applies to the two shell-script gates (`file_length` and `folder_size`), one iteration per gate.

For each gate whose `enabled: true`:

| Script | Canonical | Target |
|--------|-----------|--------|
| `check_file_length.sh` | `${PRJ}check_file_length.sh` | `tools/check_file_length.sh` |
| `check_folder_size.sh` | `${PRJ}check_folder_size.sh` | `tools/check_folder_size.sh` |

**Target absent:**
```bash
cp "${PRJ}<name>" tools/<name>
chmod +x tools/<name>
```
→ record: `install`

**Target present + F (`--force`):**
```bash
cp "${PRJ}<name>" tools/<name>
chmod +x tools/<name>
```
→ record: `re-stamp`

**Target present + ¬F:**
```bash
diff -q "${PRJ}<name>" tools/<name>
```
- Identical → no-op, record: `no-op`
- Differs → print:
  ```
  WARN: tools/<name> differs from canonical (plugins/dev-core/tools/). Run /release-setup --force to re-stamp.
  ```
  Do not modify the file. Record: `drift-warn`.

## N4 — Exemption file seed

Applies to shell-script gates only. One iteration per gate.

| Gate | Exemption file |
|------|----------------|
| `file_length` | `tools/file_exemptions.txt` |
| `folder_size` | `tools/folder_exemptions.txt` |

**File absent → create with header (never overwrite existing content):**

For `file_exemptions.txt`:
```
# Exemptions — file_length gate
# Format: <path> <issue-url>  (single-space separator)
# Each entry MUST reference a tracking issue so the exemption is recoverable.
```

For `folder_exemptions.txt`:
```
# Exemptions — folder_size gate
# Format: <path> <issue-url>  (single-space separator)
# Each entry MUST reference a tracking issue so the exemption is recoverable.
```

**File present → no-op.** Never overwrite existing exemption lists regardless of F.

## N5 — Import-linter dependency (import_layers gate only)

Applies only when `import_layers.enabled: true`.

Read `pyproject.toml` via `tomllib` (stdlib 3.11+):

```bash
uv run python - <<'PY'
import tomllib, sys
with open('pyproject.toml', 'rb') as f:
    data = tomllib.load(f)
deps = data.get('dependency-groups', {}).get('dev', [])
found = any(
    (isinstance(d, str) and d.startswith('import-linter'))
    or (isinstance(d, dict) and list(d.keys())[0].startswith('import-linter'))
    for d in deps
)
sys.exit(0 if found else 1)
PY
```

- Exit 0 → `import-linter` already in `[dependency-groups].dev` → D⏭("import-linter dep")
- Exit 1 → run:
  ```bash
  uv add --group dev import-linter
  ```
  NEVER invoke `uv sync --group dev` alone — per Decision D3, it rewrites `uv.lock`
  non-deterministically. `uv add` performs an atomic `pyproject.toml` + `uv.lock` update.

- `uv` absent or network failure → D⚠("import-linter dep — uv add failed. Install import-linter manually, then re-run /release-setup.") Continue to N6 (hooks still get wired; they will fail at pre-push time until the dep is present, which is visible to the user).

## N6 — .importlinter scaffold (import_layers gate only)

Applies only when `import_layers.enabled: true`.

**`.importlinter` exists → D⏭(".importlinter") and skip.** Never rewrite, regardless of contract state or F. Layer topology is project-owned (Decision D1).

**`.importlinter` absent → resolve `{PROJECT_PACKAGE_NAME}` then write scaffold:**

Resolution order:
1. Read `[project].name` from `pyproject.toml` via `tomllib`
2. Fallback: first entry under `[tool.uv.workspace].packages` (strip `src/` prefix if present)
3. Last fallback: name of the single directory directly under `src/`

Write `.importlinter` with substituted package name (see scaffold template section below).

## N7 — Hook merge

Applies to all enabled gates. Operates on `.pre-commit-config.yaml`.

**Hook definitions per gate:**

```yaml
# file_length gate
- id: check-file-length
  name: Check file length
  language: script
  entry: tools/check_file_length.sh
  types: [python]
  pass_filenames: false

# folder_size gate
- id: check-folder-size
  name: Check folder size
  language: script
  entry: tools/check_folder_size.sh
  pass_filenames: false

# import_layers gate — stage sourced from σ.import_layers.stage (default: pre-push)
- id: import-layers
  name: Import layer contracts
  language: system
  entry: uv run lint-imports
  pass_filenames: false
  stages: [pre-push]
```

**Algorithm — Python heredoc (copy-paste into Bash):**

```bash
uv run python - <<'PY'
import sys, os, shutil, tempfile

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML not available. Install with: uv add --group dev PyYAML", file=sys.stderr)
    sys.exit(1)

CONFIG = '.pre-commit-config.yaml'

with open(CONFIG, 'r') as f:
    raw = f.read()

data = yaml.safe_load(raw)

NEW_HOOKS = {
    'check-file-length': {
        'id': 'check-file-length',
        'name': 'Check file length',
        'language': 'script',
        'entry': 'tools/check_file_length.sh',
        'types': ['python'],
        'pass_filenames': False,
    },
    'check-folder-size': {
        'id': 'check-folder-size',
        'name': 'Check folder size',
        'language': 'script',
        'entry': 'tools/check_folder_size.sh',
        'pass_filenames': False,
    },
    'import-layers': {
        'id': 'import-layers',
        'name': 'Import layer contracts',
        'language': 'system',
        'entry': 'uv run lint-imports',
        'pass_filenames': False,
        'stages': ['pre-push'],  # overridden by σ.import_layers.stage at insertion time
    },
}

# Find the first repo: local block
local_block = None
for repo in data.get('repos', []):
    if repo.get('repo') == 'local':
        local_block = repo
        break

if local_block is None:
    # No repo: local block — create one at top of repos:
    local_block = {'repo': 'local', 'hooks': []}
    data.setdefault('repos', []).insert(0, local_block)

hooks = local_block.setdefault('hooks', [])
existing_ids = {h['id'] for h in hooks}

# For each gate hook: insert, re-stamp entry: under --force, or skip
FORCE = os.environ.get('RELEASE_SETUP_FORCE', '') == '1'

for hook_id, hook_def in NEW_HOOKS.items():
    if hook_id in existing_ids:
        if FORCE:
            # Re-stamp entry: path only; preserve stages: (Decision D4)
            for h in hooks:
                if h['id'] == hook_id:
                    h['entry'] = hook_def['entry']
                    break
        # else: no-op
        continue

    # Hook absent — find id: typecheck anchor and insert after it
    typecheck_idx = next((i for i, h in enumerate(hooks) if h.get('id') == 'typecheck'), None)
    if typecheck_idx is not None:
        hooks.insert(typecheck_idx + 1, hook_def)
        # Update typecheck_idx so subsequent inserts land in correct relative order
        typecheck_idx += 1
    else:
        # No id: typecheck found — DP(A) fallback (handled outside this script)
        print(f'NO_TYPECHECK_ANCHOR:{hook_id}', flush=True)
        continue

# Write atomically
with tempfile.NamedTemporaryFile(mode='w', dir='.', suffix='.tmp', delete=False) as tmp:
    yaml.dump(data, tmp, default_flow_style=False, sort_keys=False, allow_unicode=True)
    tmp_path = tmp.name

os.replace(tmp_path, CONFIG)
print('HOOK_MERGE_OK', flush=True)
PY
```

**Comment preservation note:** PyYAML does not preserve comments. If the project uses `ruamel.yaml` (already in the dev dep group), substitute `yaml` with `ruamel.yaml` for round-trip fidelity. The script above uses stdlib-compatible PyYAML as the default fallback.

**DP(A) fallback — no `id: typecheck` anchor:**

If the script prints `NO_TYPECHECK_ANCHOR:<hook_id>`, present:

```
── Decision: No id: typecheck anchor found in .pre-commit-config.yaml ──
Context:     Cannot locate the insertion point for quality-gate hooks.
Target:      Wire check-file-length, check-folder-size, import-layers into repo: local.
Path:        Chosen option applied immediately.

Options:
  1. Insert at end of repo: local block (default)
  2. Abort — add id: typecheck manually, then re-run /release-setup
Recommended: Option 1
```

On Option 1: append missing hooks at the end of the `repo: local` block's `hooks:` list.
On Option 2: abort cookbook, emit D⚠("Quality gates — insertion anchor id: typecheck not found").

## N8 — Summary

After all gates are processed, emit one summary line for the Phase 5 ledger:

```
Quality gates ✅ Configured (file_length: <status>, folder_size: <status>, import_layers: <status>)
```

Where `<status>` per gate is one of:
- `install` — script/hook installed from scratch
- `re-stamp` — re-stamped under --force
- `no-op` — already present and identical
- `drift-warn` — drift detected, no change (¬F)
- `skipped` — gate `enabled: false` or sub-block absent

Example (fresh install, all three gates): `Quality gates ✅ Configured (file_length: install, folder_size: install, import_layers: install)`

Example (lyra-pattern full-state, `--force`): `Quality gates ✅ Re-stamped from canonical (file_length: re-stamp, folder_size: re-stamp, import_layers: no-op)`

Example (non-Python repo): `Quality gates ⏭ Skipped (no quality_gates: section)`

## Idempotency rules

| Current state | --force | no --force |
|---|---|---|
| Gate absent | install | install |
| Gate present, identical | no-op | no-op |
| Gate present, drift | re-stamp | drift-warn, no-op |
| `.importlinter` present | preserve (D1) | preserve (D1) |
| Hook entry: matches | no-op | no-op |
| Hook entry: differs | re-stamp entry: | drift-warn, no-op |
| Hook `stages:` differs | preserve (D4) | preserve (D4) |
| All sub-blocks `enabled: false` | no-op (D6) | no-op (D6) |

Decisions D1 and D4 both hold unconditionally — even under `--force`.

## .importlinter scaffold template

Written by N6 when `.importlinter` is absent. `{PROJECT_PACKAGE_NAME}` is substituted at write time (resolved from `pyproject.toml` — see N6).

```ini
[importlinter]
root_packages =
    {PROJECT_PACKAGE_NAME}
include_external_packages = False

# ── Contracts ────────────────────────────────────────────────────────────────
# Uncomment and edit when you have defined your layer topology.
# Reference: https://import-linter.readthedocs.io/en/stable/contract_types.html
#
# [importlinter:contract:clean-architecture-layers]
# name = Clean architecture layers (example — replace with your topology)
# type = layers
# layers =
#     {PROJECT_PACKAGE_NAME}.bootstrap
#     {PROJECT_PACKAGE_NAME}.adapters
#     {PROJECT_PACKAGE_NAME}.core
```

With `[importlinter]` header + `root_packages` present and zero active contracts, `lint-imports` exits 0. "No contracts" is a valid state — not an error.

## Edge cases

| Case | Handling |
|---|---|
| `quality_gates:` present but all sub-blocks have `enabled: false` | Phase 4.5 emits `Quality gates ⏭ All gates disabled`, installs nothing, removes nothing (D6) |
| Gate previously installed, then flipped to `enabled: false` | No-op per D6. Files, hooks, and `.importlinter` all remain. Removal is a manual user action |
| User customized `tools/check_file_length.sh` (e.g. MAX=250), runs without `--force` | Drift warning printed (N3). No file changed |
| User customized script and runs with `--force` | Canonical overwrites project copy. Customization is lost. Acceptable because `--force` is explicit |
| `.importlinter` already exists with active contracts (lyra pattern) | Cookbook never rewrites `.importlinter` — D1 applies regardless of contract state or `--force` |
| `pyproject.toml` has `import-linter` pinned at a specific version | `uv add --group dev import-linter` is a no-op when the dep is already declared (any version); version is not changed |
| `pyproject.toml` has no `[dependency-groups]` section | `uv add --group dev import-linter` creates it automatically (verified uv behavior) |
| No `id: typecheck` hook in `.pre-commit-config.yaml` | DP(A): **Insert at end of `repo: local` block** (default) or **Abort**. Spec Case e |
| Multiple `repo:` blocks in `.pre-commit-config.yaml` | Cookbook targets the first `repo: local` block; if none exists, creates one at the top of `repos:` |
| Python repo without `uv` (plain pip) | `uv add` fails; cookbook emits D⚠ and instructs user to install `import-linter` manually. Hook wiring still proceeds; hooks fail at pre-commit time until dep is installed |
| Target repo pins `pre-commit` older than 2.4.0 (no `stages: [pre-push]` support) | Cookbook does not probe pre-commit version. Hook errors at pre-push time if triggered; documented here as a known edge case |

## Removal semantics

`enabled: false` on a previously-installed gate is a no-op per Decision D6. The cookbook never removes installed files or hooks; that is a manual operation. Prevents destructive surprises from a configuration flip.
