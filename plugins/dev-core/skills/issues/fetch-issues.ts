#!/usr/bin/env bun
/**
 * CLI entrypoint for fetching and displaying GitHub project issues.
 * Replaces fetch_issues.sh.
 *
 * Usage: bun ${CLAUDE_PLUGIN_ROOT}/skills/issues/fetch-issues.ts [--priority|--size] [--json] [--title-length=N]
 */

import { fetchAllItems } from './lib/fetch'
import { formatJson, formatTable } from './lib/table-formatter'

let sortBy: 'priority' | 'size' = 'priority'
let jsonOutput = false
let titleLength = 55

for (const arg of process.argv.slice(2)) {
  if (arg === '--priority') sortBy = 'priority'
  else if (arg === '--size') sortBy = 'size'
  else if (arg === '--json') jsonOutput = true
  else if (arg.startsWith('--title-length=')) titleLength = Number(arg.split('=')[1]) || 55
}

const items = await fetchAllItems()

if (jsonOutput) {
  console.log(formatJson(items))
} else {
  console.log(formatTable(items, { sortBy, titleLength }))
}
