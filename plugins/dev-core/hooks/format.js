#!/usr/bin/env node

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// All extensions common formatters can handle.
// The formatter itself decides which it actually processes — this list just
// avoids passing irrelevant files (binaries, lock files, etc.).
const FORMATTABLE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.cjs',
  '.mjs', // JS/TS
  '.json',
  '.jsonc', // JSON
  '.py', // Python
  '.rb', // Ruby
  '.go', // Go
  '.rs', // Rust
  '.css',
  '.scss',
  '.less', // CSS
  '.html',
  '.svelte',
  '.vue', // HTML/templates
  '.md',
  '.mdx', // Markdown
])

function readStackYml() {
  try {
    return fs.readFileSync(path.join(process.cwd(), '.claude', 'stack.yml'), 'utf8')
  } catch {
    return null
  }
}

/**
 * Parse the new `formatters:` array from stack.yml.
 *
 * Expects this shape (no external YAML parser needed):
 *
 *   build:
 *     formatters:
 *       - cmd: "bunx biome check --write"
 *         ext: [".ts", ".tsx", ".js", ".jsx", ".json"]
 *       - cmd: "ruff format"
 *         ext: [".py"]
 *
 * Returns null if the key is absent.
 * ext is optional — if omitted, all formattable files are passed to that cmd.
 */
function parseFormatters(text) {
  if (!text) return null
  const idx = text.indexOf('formatters:')
  if (idx === -1) return null

  // Slice from the formatters: key to the next top-level key or EOF
  const block = text.slice(idx + 'formatters:'.length)

  // Split on "- cmd:" to get each entry
  const chunks = block.split(/\n[ \t]*-[ \t]+cmd:/)
  if (chunks.length < 2) return null

  const formatters = []
  for (const chunk of chunks.slice(1)) {
    // First line is the cmd value
    const firstLine = chunk.split('\n')[0]
    let cmd = firstLine.trim()
    if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
      cmd = cmd.slice(1, -1)
    }
    if (!cmd) continue

    // ext: [".ts", ".py"] — inline array on one line
    const extMatch = chunk.match(/\bext:\s*\[([^\]]*)\]/)
    const ext = extMatch
      ? extMatch[1]
          .split(',')
          .map((e) => e.trim().replace(/['"]/g, ''))
          .filter(Boolean)
      : null // null = match all formattable extensions

    formatters.push({ cmd, ext })
  }

  return formatters.length > 0 ? formatters : null
}

/**
 * Legacy: read single build.formatter_fix_cmd from stack.yml.
 * Kept for backward compatibility with existing stack.yml files.
 */
function parseSingleCmd(text) {
  if (!text) return null
  const match = text.match(/^\s*formatter_fix_cmd:\s*(.+?)\s*$/m)
  if (!match) return null
  let val = match[1].trim()
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1)
  }
  return val || null
}

function runFormatter(cmd, files) {
  if (files.length === 0) return
  const [bin, ...args] = cmd.split(/\s+/)
  try {
    execFileSync(bin, [...args, ...files], { stdio: 'inherit', timeout: 15_000 })
  } catch {
    // Non-zero exit is non-fatal — must not block writes.
  }
}

function main() {
  const yml = readStackYml()
  const formatters = parseFormatters(yml)
  const singleCmd = !formatters ? parseSingleCmd(yml) : null

  if (!formatters && !singleCmd) {
    // No formatter configured — skip silently.
    process.exit(0)
  }

  const rawPaths = process.env.CLAUDE_FILE_PATHS
  if (!rawPaths) process.exit(0)

  const allFiles = rawPaths
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .filter((p) => FORMATTABLE_EXTENSIONS.has(path.extname(p)))

  if (allFiles.length === 0) process.exit(0)

  if (formatters) {
    // Multi-formatter: route each file to the right formatter by extension.
    for (const { cmd, ext } of formatters) {
      const files = ext ? allFiles.filter((p) => ext.includes(path.extname(p))) : allFiles
      runFormatter(cmd, files)
    }
  } else {
    // Single formatter: pass all matching files.
    runFormatter(singleCmd, allFiles)
  }
}

main()
