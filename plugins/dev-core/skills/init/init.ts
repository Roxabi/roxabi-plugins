#!/usr/bin/env bun
/**
 * dev-core shim — delegates to dev-init init CLI.
 * Resolves ${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts when dev-core is the active plugin root.
 *
 * Resolution order (source-of-truth first):
 *   1. Flat siblings — marketplace clone, repo plugins/, --plugin-dir
 *   2. Versioned cache — ~/.claude/plugins/cache/<mp>/dev-init/<ver>/…
 *      skips dirs with .orphaned_at; picks newest mtime (mirrors scaffold SHIM_CONTENT)
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const ENTRY = join('skills', 'init', 'init.ts')

function isEntry(path: string): boolean {
  return existsSync(path)
}

/** Newest non-orphaned version dir under cacheBase that contains ENTRY. */
function resolveVersionedCache(cacheBase: string): string | null {
  if (!existsSync(cacheBase)) return null
  let best: { path: string; mtime: number } | null = null
  for (const name of readdirSync(cacheBase)) {
    if (name.startsWith('.')) continue
    const versionDir = join(cacheBase, name)
    try {
      if (!statSync(versionDir).isDirectory()) continue
    } catch {
      continue
    }
    if (existsSync(join(versionDir, '.orphaned_at'))) continue
    const entry = join(versionDir, ENTRY)
    if (!isEntry(entry)) continue
    let mtime = 0
    try {
      mtime = statSync(versionDir).mtimeMs
    } catch {
      continue
    }
    if (!best || mtime > best.mtime) best = { path: entry, mtime }
  }
  return best?.path ?? null
}

/** Derive …/cache/<mp>/dev-init from …/cache/<mp>/dev-core/<ver>. */
function cacheBaseFromDevCoreRoot(root: string): string | null {
  const normalized = root.replace(/\\/g, '/')
  const match = normalized.match(/^(.*)\/cache\/([^/]+)\/dev-core\/[^/]+\/?$/)
  if (!match) return null
  return join(match[1], 'cache', match[2], 'dev-init')
}

export function resolveDevInitEntry(root = process.env.CLAUDE_PLUGIN_ROOT ?? join(import.meta.dir, '../..')): string {
  // 1. Flat siblings first — --plugin-dir / marketplace / monorepo source
  const flat = [join(dirname(root), 'dev-init', ENTRY), join(root, '..', 'dev-init', ENTRY)]
  for (const candidate of flat) {
    if (isEntry(candidate)) return candidate
  }

  // 2. Versioned plugin cache
  const derived = cacheBaseFromDevCoreRoot(root)
  const bases = [
    ...(derived ? [derived] : []),
    join(homedir(), '.claude', 'plugins', 'cache', 'roxabi-marketplace', 'dev-init'),
  ]
  const seen = new Set<string>()
  for (const base of bases) {
    if (seen.has(base)) continue
    seen.add(base)
    const hit = resolveVersionedCache(base)
    if (hit) return hit
  }

  console.error(
    'dev-init plugin not found — install dev-init from roxabi-marketplace (sibling of dev-core). Cache layout is version-scoped: …/dev-init/<version>/skills/init/init.ts',
  )
  process.exit(1)
}

// Only run when executed as CLI (not when imported by tests)
if (import.meta.main) {
  const target = resolveDevInitEntry()
  const proc = Bun.spawnSync(['bun', target, ...process.argv.slice(2)], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(proc.exitCode ?? 1)
}
