# Data Management

Plugins that produce or consume user data follow these rules.

## Storage

- **Default location:** `~/.roxabi-vault/` — user data lives outside this repository
- **Override:** set `ROXABI_VAULT_HOME` for a custom location
- **Permissions:** directories created with mode `0o700`
- **Shared directories:** declare only active, documented shared storage
- **Exclusive directories:** declare a unique active plugin-owned root in `plugin.json`
## plugin.json extended format

Plugins with data declare it in `plugin.json`:

```json
{
  "data": {
    "root": "plugin-data",
    "directories": ["generated"],
    "files": {
      "example.json": {
        "description": "Example user data",
        "sensitive": true,
        "example": "examples/example.json"
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

Active plugins must resolve user-data paths from their own maintained runtime dependency or the external [roxabi-vault](https://github.com/Roxabi/roxabi-vault). Do not import helpers from retired plugins or archive source.

## Rules

1. **Zero personal data** in the repo — use fictional data in `examples/`
2. **English names** — use stable, descriptive storage names
3. **Self-check in skills** — verify preconditions at start, suggest an active setup path if data is missing
4. **No archive dependencies** — active code and instructions never import or execute content below `archived/`
5. **CI checks** — `tools/validate_plugins.py` enforces no personal data, unique `data.root`, and referenced examples
