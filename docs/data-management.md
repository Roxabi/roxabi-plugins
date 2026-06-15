# Data Management

Plugins that produce or consume user data follow these rules.

## Storage

- **Default location:** `~/.roxabi-vault/` — all user data lives here, never in the repo
- **Override:** set `ROXABI_VAULT_HOME` environment variable for a custom location
- **Permissions:** directories created with mode `0o700`
- **Shared directories:** `content/`, `ideas/`, `learnings/` — used by multiple plugins
- **Exclusive directories:** `cv/`, `invoices/`, `linkedin-apply/` — owned by one plugin (`data.root` in `plugin.json`)

## plugin.json extended format

Plugins with data declare it in `plugin.json`:

```json
{
  "data": {
    "root": "cv",
    "directories": ["generated", "adapted"],
    "files": {
      "cv_data.json": {
        "description": "Master CV data",
        "sensitive": true,
        "example": "examples/cv_data.example.json"
      }
    },
    "shared": []
  }
}
```

- `data.root` must be unique across all plugins (enforced by `tools/validate_plugins.py`)
- `data.shared` lists shared directories the plugin reads/writes
- `data.files[].example` points to a template with fictional data in `examples/`

## Path Resolution

All plugins use `roxabi_sdk/paths.py` for path resolution.

The canonical copy lives at `roxabi_sdk/paths.py` (repo root). The sync script copies `roxabi_sdk/` into each plugin cache dir so imports work in both repo and installed contexts.

Key functions:
- `get_vault_home()`
- `get_plugin_data(name)`
- `get_shared_dir(name)`
- `get_config(name)`
- `ensure_dir(path)`

Vault/indexing functionality has moved to [roxabi-vault](https://github.com/Roxabi/roxabi-vault).

## Rules

1. **Zero personal data** in the repo — use fictional data in `examples/`
2. **English names** — `invoices/` not `factures/`, skills in English
3. **Self-check in skills** — verify preconditions at start, suggest init skill if data missing
4. **Shared SDK** — `roxabi_sdk/` at repo root is the single source of truth for path resolution. Sync script copies it into each plugin cache dir. Import via `from roxabi_sdk.paths import ...`
5. **CI checks** — `tools/validate_plugins.py` enforces no personal data, unique `data.root`, examples exist
