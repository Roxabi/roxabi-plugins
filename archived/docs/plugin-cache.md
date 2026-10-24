# Plugin Source and Cache

The repository source is authoritative. Installed plugin copies are host-managed, ephemeral caches:
editing a cache never changes the source, and a later install or upgrade can replace it.

## Claude Code

Add a marketplace once, then install the plugin:

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install issue-triage
```

When a source revision is available from the marketplace, reinstall the plugin to refresh the
Claude Code cache:

```bash
claude plugin install <plugin-name>
```

Do not edit the Claude cache directly.

## OMP

Add the marketplace once and install the host-supported plugin:

```bash
omp plugin marketplace add Roxabi/roxabi-plugins
omp plugin install <plugin>@roxabi-marketplace
```

After a marketplace revision lands, update the marketplace, upgrade the installed plugin, then
restart OMP:

```bash
omp plugin marketplace update roxabi-marketplace
omp plugin upgrade <plugin>@roxabi-marketplace
```

Do not use `/reload-plugins` as an upgrade mechanism.

## Rules

1. Change the repository source, never only an installed cache.
2. Use the host's install or upgrade flow to pick up a published revision.
3. Treat local caches as rebuildable delivery copies, not workflow or user-data authority.
