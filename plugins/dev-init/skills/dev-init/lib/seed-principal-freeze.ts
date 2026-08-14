/**
 * Seed principal-freeze lefthook/pre-commit gate into a consumer project.
 * Canonical script: plugins/dev-core/scripts/check-principal-branch.sh
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = 'check-principal-branch.sh'
const RUN = 'bash scripts/check-principal-branch.sh'

export type SeedPrincipalFreezeOpts = {
  cwd?: string
  force?: boolean
  sourceDir?: string
  /** When false, only copy the script (default: also patch lefthook / pre-commit if present). */
  patchHooks?: boolean
}

export type SeedPrincipalFreezeResult = {
  written: string[]
  skipped: string[]
  patched: string[]
  sourceDir: string
  error?: string
}

function newestScriptsDir(pluginRoot: string): string | null {
  if (!existsSync(pluginRoot)) return null
  let best: { path: string; mtime: number } | null = null
  let entries: string[]
  try {
    entries = readdirSync(pluginRoot)
  } catch {
    return null
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const scripts = join(pluginRoot, name, 'scripts')
    const check = join(scripts, SCRIPT)
    if (!existsSync(check)) continue
    let mtime = 0
    try {
      mtime = statSync(check).mtimeMs
    } catch {
      continue
    }
    if (!best || mtime > best.mtime) best = { path: scripts, mtime }
  }
  return best?.path ?? null
}

export function resolvePrincipalFreezeSourceDir(explicit?: string): string | null {
  if (explicit) {
    return existsSync(join(explicit, SCRIPT)) ? explicit : null
  }

  for (const envKey of ['CLAUDE_PLUGIN_ROOT', 'GROK_PLUGIN_ROOT'] as const) {
    const root = process.env[envKey]
    if (!root) continue
    const candidate = join(root, 'scripts')
    if (existsSync(join(candidate, SCRIPT))) return candidate
    const peer = join(dirname(root), 'dev-core', 'scripts')
    if (existsSync(join(peer, SCRIPT))) return peer
    const scanned = newestScriptsDir(join(dirname(root), 'dev-core'))
    if (scanned) return scanned
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const monorepo = join(here, '..', '..', '..', '..', 'dev-core', 'scripts')
  if (existsSync(join(monorepo, SCRIPT))) return monorepo

  return null
}

export function lefthookHasPrincipalFreeze(yaml: string): boolean {
  return yaml.includes('check-principal-branch.sh') || /^\s*principal-freeze\s*:/m.test(yaml)
}

export function insertLefthookPrincipalFreeze(yaml: string): { yaml: string; changed: boolean } {
  if (lefthookHasPrincipalFreeze(yaml)) return { yaml, changed: false }
  let out = yaml
  let changed = false
  for (const section of ['pre-commit', 'pre-push'] as const) {
    const next = insertIntoLefthookSection(out, section)
    if (next !== out) {
      out = next
      changed = true
    }
  }
  return { yaml: out, changed }
}

function insertIntoLefthookSection(yaml: string, section: string): string {
  const header = new RegExp(`^${section}:\\s*$`, 'm')
  const m = header.exec(yaml)
  if (!m) return yaml
  const start = m.index + m[0].length
  const rest = yaml.slice(start)
  const nextTop = rest.search(/^\S/m)
  const body = nextTop === -1 ? rest : rest.slice(0, nextTop)
  const cmds = /^([ \t]*)commands:\s*$/m.exec(body)
  if (!cmds) return yaml
  const indent = cmds[1] ?? '  '
  const child = `${indent}  `
  const block = `\n${child}principal-freeze:\n${child}  run: ${RUN}`
  const insertAt = start + (cmds.index ?? 0) + cmds[0].length
  return yaml.slice(0, insertAt) + block + yaml.slice(insertAt)
}

const PRE_COMMIT_BLOCK = `  - repo: local
    hooks:
      - id: principal-freeze
        name: principal freeze
        entry: ${RUN}
        language: system
        pass_filenames: false
`

export function insertPreCommitPrincipalFreeze(yaml: string): { yaml: string; changed: boolean } {
  if (yaml.includes('check-principal-branch.sh') || yaml.includes('id: principal-freeze')) {
    return { yaml, changed: false }
  }
  const trimmed = yaml.endsWith('\n') ? yaml : `${yaml}\n`
  return { yaml: trimmed + PRE_COMMIT_BLOCK, changed: true }
}

export function seedPrincipalFreeze(opts: SeedPrincipalFreezeOpts = {}): SeedPrincipalFreezeResult {
  const cwd = opts.cwd ?? process.cwd()
  const force = opts.force === true
  const patchHooks = opts.patchHooks !== false
  const sourceDir = resolvePrincipalFreezeSourceDir(opts.sourceDir)

  if (!sourceDir) {
    return {
      written: [],
      skipped: [],
      patched: [],
      sourceDir: '',
      error: 'principal-freeze seed source not found — install/enable dev-core or pass sourceDir',
    }
  }

  const destDir = join(cwd, 'scripts')
  mkdirSync(destDir, { recursive: true })

  const written: string[] = []
  const skipped: string[] = []
  const patched: string[] = []

  const src = join(sourceDir, SCRIPT)
  const dest = join(destDir, SCRIPT)
  if (!existsSync(src)) {
    return {
      written,
      skipped,
      patched,
      sourceDir,
      error: `missing seed file: ${src}`,
    }
  }

  if (existsSync(dest) && !force) {
    skipped.push(dest)
  } else if (existsSync(dest) && force && readFileSync(src).equals(readFileSync(dest))) {
    skipped.push(dest)
  } else {
    copyFileSync(src, dest)
    written.push(dest)
  }

  try {
    chmodSync(dest, 0o755)
  } catch {
    // non-fatal on platforms without chmod
  }

  if (patchHooks) {
    const lefthookPath = existsSync(join(cwd, 'lefthook.yml'))
      ? join(cwd, 'lefthook.yml')
      : existsSync(join(cwd, '.lefthook.yml'))
        ? join(cwd, '.lefthook.yml')
        : null
    if (lefthookPath) {
      const raw = readFileSync(lefthookPath, 'utf8')
      const next = insertLefthookPrincipalFreeze(raw)
      if (next.changed) {
        writeFileSync(lefthookPath, next.yaml)
        patched.push(lefthookPath)
      }
    }

    const preCommitPath = join(cwd, '.pre-commit-config.yaml')
    if (existsSync(preCommitPath)) {
      const raw = readFileSync(preCommitPath, 'utf8')
      const next = insertPreCommitPrincipalFreeze(raw)
      if (next.changed) {
        writeFileSync(preCommitPath, next.yaml)
        patched.push(preCommitPath)
      }
    }
  }

  return { written, skipped, patched, sourceDir }
}
