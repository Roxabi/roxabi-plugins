# web-design-guidelines

Review UI code for compliance with the Web Interface Guidelines. Fetches the latest rules at runtime from the upstream source.

Forked from [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines).

## Install

```bash
claude plugin marketplace add Roxabi/roxabi-plugins
claude plugin install web-design-guidelines
```

## Usage

Trigger phrases:

- "review my UI"
- "check accessibility"
- "audit design"
- "review UX"
- "web design guidelines"

You can pass files or patterns as arguments:

```
/web-design-guidelines src/app/page.tsx
```

## What it does

1. Fetches the latest Web Interface Guidelines from the upstream source
2. Reads the specified files
3. Checks all rules against your code
4. Outputs findings in `file:line` format

Unlike the other two Vercel skills, this one fetches rules at runtime via WebFetch so it always has the latest version.

## License

MIT — original content by [Vercel](https://github.com/vercel-labs).
