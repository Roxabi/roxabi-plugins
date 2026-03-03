#!/usr/bin/env node

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// All extensions common formatters can handle.
// The formatter itself decides which it actually processes — this list just
// avoids passing irrelevant files (binaries, lock files, etc.).
const FORMATTABLE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', // JS/TS
  '.json', '.jsonc',                              // JSON
  '.py',                                          // Python
  '.rb',                                          // Ruby
  '.go',                                          // Go
  '.rs',                                          // Rust
  '.css', '.scss', '.less',                       // CSS
  '.html', '.svelte', '.vue',                     // HTML/templates
  '.md', '.mdx',                                  // Markdown
])

/**
 * Read build.formatter_fix_cmd from .claude/stack.yml.
 * Returns null if the file doesn't exist or the key is empty/absent.
 */
function readFormatterCmd() {
  const ymlPath = path.join(process.cwd(), '.claude', 'stack.yml')
  try {
    const text = fs.readFileSync(ymlPath, 'utf8')
    const match = text.match(/^\s*formatter_fix_cmd:\s*(.+?)\s*$/m)
    if (!match) return null
    let val = match[1].trim()
    // Strip surrounding quotes ("cmd" or 'cmd')
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    return val || null
  } catch {
    return null
  }
}

function main() {
  const formatterCmd = readFormatterCmd()
  if (!formatterCmd) {
    // No formatter configured in stack.yml — skip silently.
    process.exit(0)
  }

  const rawPaths = process.env.CLAUDE_FILE_PATHS
  if (!rawPaths) {
    process.exit(0)
  }

  const filePaths = rawPaths
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .filter((p) => FORMATTABLE_EXTENSIONS.has(path.extname(p)))

  if (filePaths.length === 0) {
    process.exit(0)
  }

  // Split "bunx biome check --write" → ['bunx', 'biome', 'check', '--write']
  // then append file paths as additional args — safe, no shell interpolation.
  const [bin, ...args] = formatterCmd.split(/\s+/)
  try {
    execFileSync(bin, [...args, ...filePaths], {
      stdio: 'inherit',
      timeout: 15_000,
    })
  } catch {
    // Non-zero exit from formatter is non-fatal — formatting errors must not block writes.
    process.exit(0)
  }
}

main()
