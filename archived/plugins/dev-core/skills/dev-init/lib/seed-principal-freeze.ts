/**
 * Seed principal-freeze lefthook/pre-commit gate into a consumer project.
 * Canonical script: ${CLAUDE_PLUGIN_ROOT}/scripts/check-principal-branch.sh or monorepo dev-core/scripts/.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  lefthookSectionBindsPrincipalFreeze,
  lefthookTopLevelSectionBody,
  PRINCIPAL_FREEZE_RUN,
  PRINCIPAL_FREEZE_SCRIPT,
  preCommitHasPrincipalFreeze,
} from '../../shared/lefthook-persist'

export {
  lefthookHasPrincipalFreeze,
  lefthookSectionBindsPrincipalFreeze,
  lefthookTopLevelSectionBody,
  preCommitHasPrincipalFreeze,
} from '../../shared/lefthook-persist'

const SCRIPT = PRINCIPAL_FREEZE_SCRIPT
const RUN = PRINCIPAL_FREEZE_RUN

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
  persist?: boolean
  lefthookPreCommit?: boolean
  lefthookPrePush?: boolean
  scriptCanonical?: boolean
  error?: string
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
  }

  // Monorepo: from skills/dev-init/lib/ → dev-core/scripts (no sibling dev-init scan post-merge)
  const here = dirname(fileURLToPath(import.meta.url))
  const monorepo = join(here, '..', '..', '..', 'scripts')
  if (existsSync(join(monorepo, SCRIPT))) return monorepo

  return null
}

const MISSING_SECTION = (section: string) => `\n${section}:\n  commands:\n    principal-freeze:\n      run: ${RUN}\n`

export function insertLefthookPrincipalFreeze(yaml: string): { yaml: string; changed: boolean } {
  let out = yaml
  let changed = false
  for (const section of ['pre-commit', 'pre-push'] as const) {
    if (lefthookSectionBindsPrincipalFreeze(out, section)) continue
    if (lefthookTopLevelSectionBody(out, section) === null) {
      out = `${out.replace(/\s*$/, '')}${MISSING_SECTION(section)}`
      changed = true
      continue
    }
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
  if (preCommitHasPrincipalFreeze(yaml)) {
    return { yaml, changed: false }
  }
  const trimmed = yaml.endsWith('\n') ? yaml : `${yaml}\n`
  return { yaml: trimmed + PRE_COMMIT_BLOCK, changed: true }
}

export function seedPrincipalFreeze(opts: SeedPrincipalFreezeOpts = {}): SeedPrincipalFreezeResult {
  const cwd = opts.cwd ?? process.cwd()
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

  const srcBytes = readFileSync(src)
  const destCanonical = existsSync(dest) && srcBytes.equals(readFileSync(dest))
  if (destCanonical) {
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

  return attachPersist({ written, skipped, patched, sourceDir }, cwd, sourceDir)
}

export type InspectPrincipalFreezeResult = {
  persist: boolean
  scriptExists: boolean
  scriptCanonical: boolean
  lefthookPath: string | null
  lefthookPreCommit: boolean
  lefthookPrePush: boolean
  preCommitConfig: boolean
}

export function inspectPrincipalFreeze(opts: { cwd?: string; sourceDir?: string } = {}): InspectPrincipalFreezeResult {
  const cwd = opts.cwd ?? process.cwd()
  const sourceDir = resolvePrincipalFreezeSourceDir(opts.sourceDir)
  const dest = join(cwd, 'scripts', SCRIPT)
  const scriptExists = existsSync(dest)
  const src = sourceDir ? join(sourceDir, SCRIPT) : ''
  const scriptCanonical =
    scriptExists && Boolean(sourceDir) && existsSync(src) && readFileSync(src).equals(readFileSync(dest))

  const lefthookPath = existsSync(join(cwd, 'lefthook.yml'))
    ? join(cwd, 'lefthook.yml')
    : existsSync(join(cwd, '.lefthook.yml'))
      ? join(cwd, '.lefthook.yml')
      : null
  let lefthookPreCommit = false
  let lefthookPrePush = false
  if (lefthookPath) {
    const yaml = readFileSync(lefthookPath, 'utf8')
    lefthookPreCommit = lefthookSectionBindsPrincipalFreeze(yaml, 'pre-commit')
    lefthookPrePush = lefthookSectionBindsPrincipalFreeze(yaml, 'pre-push')
  }

  const preCommitPath = join(cwd, '.pre-commit-config.yaml')
  const preCommitConfig = existsSync(preCommitPath) && preCommitHasPrincipalFreeze(readFileSync(preCommitPath, 'utf8'))

  const lefthookOk = lefthookPath ? lefthookPreCommit && lefthookPrePush : null
  const persist = scriptCanonical && (lefthookOk === true || (lefthookOk === null && preCommitConfig))

  return {
    persist,
    scriptExists,
    scriptCanonical,
    lefthookPath,
    lefthookPreCommit,
    lefthookPrePush,
    preCommitConfig,
  }
}

function attachPersist(base: SeedPrincipalFreezeResult, cwd: string, sourceDir: string): SeedPrincipalFreezeResult {
  const inspect = inspectPrincipalFreeze({ cwd, sourceDir })
  return {
    ...base,
    persist: inspect.persist,
    lefthookPreCommit: inspect.lefthookPreCommit,
    lefthookPrePush: inspect.lefthookPrePush,
    scriptCanonical: inspect.scriptCanonical,
  }
}
