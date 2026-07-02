#!/usr/bin/env bun
/**
 * dev-core shim — delegates to dev-init init CLI.
 * Resolves ${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts when dev-core is the active plugin root.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

function resolveDevInitEntry(): string {
  const root = process.env.CLAUDE_PLUGIN_ROOT ?? join(import.meta.dir, '../..')
  const candidates = [
    join(dirname(root), 'dev-init', 'skills', 'init', 'init.ts'),
    join(root, '..', 'dev-init', 'skills', 'init', 'init.ts'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  console.error('dev-init plugin not found — install dev-init from roxabi-marketplace (sibling of dev-core).')
  process.exit(1)
}

const target = resolveDevInitEntry()
const proc = Bun.spawnSync(['bun', target, ...process.argv.slice(2)], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(proc.exitCode ?? 1)
