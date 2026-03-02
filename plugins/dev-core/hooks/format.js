#!/usr/bin/env node

'use strict'

const { execFileSync } = require('node:child_process')
const path = require('node:path')

const FORMATTABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json'])

function main() {
  const rawPaths = process.env.CLAUDE_FILE_PATHS
  if (!rawPaths) {
    process.exit(0)
  }

  // Split on newlines (Claude passes one path per line)
  const filePaths = rawPaths
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .filter((p) => FORMATTABLE_EXTENSIONS.has(path.extname(p)))

  if (filePaths.length === 0) {
    process.exit(0)
  }

  try {
    execFileSync('bunx', ['biome', 'check', '--write', ...filePaths], {
      stdio: 'inherit',
      timeout: 10_000,
    })
  } catch {
    // Non-zero exit from biome is non-fatal — formatting errors should not block writes
    process.exit(0)
  }
}

main()
