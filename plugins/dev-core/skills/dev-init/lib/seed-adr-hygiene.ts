/**
 * Seed the ADR hygiene gate into a consumer project.
 * Source of truth: ${CLAUDE_PLUGIN_ROOT}/scripts/ or monorepo plugins/dev-core/scripts/.
 *
 * Idempotent by default: an existing `scripts/check-agents-adr-hygiene.sh` is
 * left alone, because a consumer that tuned its modes or its ADR path must not
 * lose that on the next `/R-dev-init`.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = 'check-agents-adr-hygiene.sh'

export interface SeedAdrHygieneOpts {
  /** Project root (default: cwd) */
  cwd?: string
  /** Overwrite an existing script */
  force?: boolean
  /** Directory containing the script. Default: env / monorepo layout. */
  sourceDir?: string
}

export interface SeedAdrHygieneResult {
  written: string[]
  skipped: string[]
  sourceDir: string
  /** Contract version implemented by the script that ships with this plugin. */
  sourceVersion: string | null
  /** Contract version implemented by the copy now in the project. */
  localVersion: string | null
  /**
   * The local copy enforces an older contract than the one shipping.
   *
   * The gate ships **by value**, so a copy taken before a vocabulary change
   * keeps rejecting ADRs that are legal upstream — and a rejection reads
   * identically whether the ADR is wrong or the gate is old. Nothing else in
   * the repository can tell the two apart, so the seeder says which it is.
   */
  stale: boolean
  error?: string
}

/** `CONTRACT_VERSION="N"` as declared by a hygiene script, or null. */
function contractVersion(path: string): string | null {
  try {
    return /^CONTRACT_VERSION="(\d+)"/m.exec(readFileSync(path, 'utf-8'))?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Resolve the directory that ships the hygiene script.
 * Order: explicit sourceDir → CLAUDE/GROK_PLUGIN_ROOT/scripts → monorepo layout.
 */
export function resolveAdrHygieneSourceDir(explicit?: string): string | null {
  if (explicit) {
    // Explicit path is authoritative — do not fall through on miss
    return existsSync(join(explicit, SCRIPT)) ? explicit : null
  }

  for (const envKey of ['CLAUDE_PLUGIN_ROOT', 'GROK_PLUGIN_ROOT'] as const) {
    const root = process.env[envKey]
    if (!root) continue
    const candidate = join(root, 'scripts')
    if (existsSync(join(candidate, SCRIPT))) return candidate
  }

  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const monorepo = join(here, '..', '..', '..', 'scripts')
    if (existsSync(join(monorepo, SCRIPT))) return monorepo
  } catch {
    // ignore
  }

  return null
}

/** Idempotent seed of scripts/check-agents-adr-hygiene.sh. */
export function seedAdrHygieneScript(opts: SeedAdrHygieneOpts = {}): SeedAdrHygieneResult {
  const cwd = opts.cwd ?? process.cwd()
  const force = opts.force === true
  const sourceDir = resolveAdrHygieneSourceDir(opts.sourceDir)

  if (!sourceDir) {
    return {
      written: [],
      skipped: [],
      sourceDir: '',
      sourceVersion: null,
      localVersion: null,
      stale: false,
      error: 'adr hygiene seed source not found — install/enable dev-core plugin or pass sourceDir',
    }
  }

  const src = join(sourceDir, SCRIPT)
  const destDir = join(cwd, 'scripts')
  const dest = join(destDir, SCRIPT)
  mkdirSync(destDir, { recursive: true })

  const written: string[] = []
  const skipped: string[] = []

  // Without --force a local copy is kept whatever it contains; with --force an
  // identical copy is still a skip, so re-running produces no diff noise.
  const keepLocal = existsSync(dest) && (!force || readFileSync(src).equals(readFileSync(dest)))
  if (keepLocal) {
    skipped.push(dest)
  } else {
    copyFileSync(src, dest)
    try {
      chmodSync(dest, 0o755)
    } catch {
      // non-fatal on platforms without chmod
    }
    written.push(dest)
  }

  // A script that is not executable is not a gate — fix the mode even on skip.
  try {
    if ((statSync(dest).mode & 0o111) === 0) chmodSync(dest, 0o755)
  } catch {
    // ignore
  }

  const sourceVersion = contractVersion(src)
  const localVersion = contractVersion(dest)
  const stale = sourceVersion !== null && localVersion !== null && Number(localVersion) < Number(sourceVersion)

  return { written, skipped, sourceDir, sourceVersion, localVersion, stale }
}
