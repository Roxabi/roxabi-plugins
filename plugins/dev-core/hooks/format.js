#!/usr/bin/env node

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { parseStackYml } = require('./lib/parse-stack-yml.cjs')

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
  const { formatters, singleFormatterCmd } = parseStackYml(yml)

  if (!formatters && !singleFormatterCmd) {
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
    runFormatter(singleFormatterCmd, allFiles)
  }
}

main()
