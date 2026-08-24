/**
 * Seed local primary secret-scan scripts into a consumer project.
 * Source of truth: ${CLAUDE_PLUGIN_ROOT}/scripts/trufflehog-* or monorepo plugins/dev-core/scripts/.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FILES = ['trufflehog-check.sh', 'trufflehog-exclude-paths.txt'] as const

export type SeedTrufflehogOpts = {
  /** Project root (default: cwd) */
  cwd?: string
  /** Overwrite existing scripts */
  force?: boolean
  /**
   * Directory containing trufflehog-check.sh + trufflehog-exclude-paths.txt.
   * Default: resolve from env / monorepo layout.
   */
  sourceDir?: string
}

export type SeedTrufflehogResult = {
  written: string[]
  skipped: string[]
  sourceDir: string
  error?: string
}
/**
 * Resolve the directory that ships the trufflehog seed files.
 * Order: explicit sourceDir → CLAUDE/GROK_PLUGIN_ROOT/scripts → monorepo layout from this lib/.
 * No peer-cache, versioned-sibling, or marketplace grandparent scans (dead post-merge).
 */
export function resolveTrufflehogSourceDir(explicit?: string): string | null {
  if (explicit) {
    // Explicit path is authoritative — do not fall through on miss
    return existsSync(join(explicit, 'trufflehog-check.sh')) ? explicit : null
  }

  for (const envKey of ['CLAUDE_PLUGIN_ROOT', 'GROK_PLUGIN_ROOT'] as const) {
    const root = process.env[envKey]
    if (!root) continue
    const candidate = join(root, 'scripts')
    if (existsSync(join(candidate, 'trufflehog-check.sh'))) return candidate
  }

  // Monorepo: skills/dev-init/lib/ → dev-core/scripts (adjusted for merged location)
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const monorepo = join(here, '..', '..', '..', 'scripts')
    if (existsSync(join(monorepo, 'trufflehog-check.sh'))) return monorepo
  } catch {
    // ignore
  }

  return null
}

/**
 * Idempotent seed of scripts/trufflehog-check.sh + trufflehog-exclude-paths.txt.
 */
export function seedTrufflehogScripts(opts: SeedTrufflehogOpts = {}): SeedTrufflehogResult {
  const cwd = opts.cwd ?? process.cwd()
  const force = opts.force === true
  const sourceDir = resolveTrufflehogSourceDir(opts.sourceDir)

  if (!sourceDir) {
    return {
      written: [],
      skipped: [],
      sourceDir: '',
      error: 'trufflehog seed source not found — install/enable dev-core plugin or pass sourceDir',
    }
  }

  const destDir = join(cwd, 'scripts')
  mkdirSync(destDir, { recursive: true })

  const written: string[] = []
  const skipped: string[] = []

  for (const name of FILES) {
    const src = join(sourceDir, name)
    const dest = join(destDir, name)
    if (!existsSync(src)) {
      return {
        written,
        skipped,
        sourceDir,
        error: `missing seed file: ${src}`,
      }
    }

    if (existsSync(dest) && !force) {
      // Keep consumer customizations; only skip when present
      skipped.push(dest)
      continue
    }

    // force: only overwrite if content differs (avoid noise)
    if (existsSync(dest) && force) {
      const a = readFileSync(src)
      const b = readFileSync(dest)
      if (a.equals(b)) {
        skipped.push(dest)
        continue
      }
    }

    copyFileSync(src, dest)
    if (name.endsWith('.sh')) {
      try {
        chmodSync(dest, 0o755)
      } catch {
        // non-fatal on platforms without chmod
      }
    }
    written.push(dest)
  }

  // Ensure executable even on skip if file already existed without +x
  const checkSh = join(destDir, 'trufflehog-check.sh')
  if (existsSync(checkSh)) {
    try {
      const mode = statSync(checkSh).mode
      if ((mode & 0o111) === 0) chmodSync(checkSh, 0o755)
    } catch {
      // ignore
    }
  }

  return { written, skipped, sourceDir }
}
