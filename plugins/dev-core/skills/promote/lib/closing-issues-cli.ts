/**
 * CLI for collect-closing-issues.sh — SSOT extract/format path.
 *
 * Usage:
 *   bun run lib/closing-issues-cli.ts --list    < texts
 *   bun run lib/closing-issues-cli.ts --section < texts
 *   bun run lib/closing-issues-cli.ts --json    < texts
 *
 * Reads UTF-8 text from stdin; writes formatted output to stdout.
 * Exit 0 always when parse succeeds (empty list is success).
 */
import { extractClosingIssueNumbers, formatClosesSection, formatIssuesJson } from './closing-issues'

const modeArg = process.argv.find((a) => a === '--list' || a === '--section' || a === '--json')
const mode = modeArg === '--section' ? 'section' : modeArg === '--json' ? 'json' : 'list'

const chunks: Buffer[] = []
for await (const chunk of process.stdin) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
}
const text = Buffer.concat(chunks).toString('utf8')
const issues = extractClosingIssueNumbers(text)

switch (mode) {
  case 'json':
    process.stdout.write(`${formatIssuesJson(issues)}\n`)
    break
  case 'section': {
    const section = formatClosesSection(issues)
    if (section) process.stdout.write(section)
    break
  }
  default:
    if (issues.length > 0) process.stdout.write(`${issues.join('\n')}\n`)
    break
}
