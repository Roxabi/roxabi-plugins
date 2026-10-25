# External Ecosystem

Roxabi curates installable external marketplaces; it does not vendor them into active plugin
source. [`.claude-plugin/external-registry.json`](../.claude-plugin/external-registry.json) is the
record of active and retired entries. Its `status: active` projection is
[`.claude-plugin/curated-marketplaces.json`](../.claude-plugin/curated-marketplaces.json).

Users install an active upstream directly:

```bash
claude plugin marketplace add <source>
```

## Active curation

An upstream qualifies when it:

- provides a supported direct install path, including an upstream marketplace manifest;
- is maintained and has useful, clearly scoped content;
- has a compatible license; and
- does not substantially duplicate a retained Roxabi plugin.

Add a qualified source to the registry with its check metadata, then add the same `name` and
`source` to the active mirror. Keep the root README table aligned with that mirror. The mirror is
an active install recommendation, not a historical catalog. Repository validation compares the
active projection and mirror by `name` and `source` without relying on order; duplicate identities
or mismatched sources are invalid, while deprecated records are ignored.

## Retirement lifecycle

Deprecate an entry when its upstream is archived or deleted, no longer maintained, becomes
incompatible, or is otherwise no longer suitable for active curation.

1. Set the registry entry's `status` to `deprecated`.
2. Add a dated, factual reason in its `notes`.
3. Remove it from the active mirror and the root README table.
4. Keep its registry entry as historical evidence.

An archived upstream is never promoted as an active recommendation. A possible replacement must
independently meet the active-curation criteria; deprecation does not nominate one.

Historical wrapping and subtree procedures are in
[archived/docs/legacy-plugin-authoring.md](../archived/docs/legacy-plugin-authoring.md), outside
the active contributor path.
