/**
 * Artifact frontmatter classification — pure TS, called from lib.sh via bun.
 *
 * Why this exists: `artifacts/analyses/` holds legacy brainstorm + consensus
 * files alongside real analyses. Filename is not a discriminator. Bash/awk
 * fence parsers failed three review rounds (CRLF/BOM/space, unterminated
 * fence printing the body as header, first-wins vs YAML last-wins). Classify
 * here so the contract is unit-tested like the rest of the plugin.
 *
 * Consumers: dev/scan-state.sh, pr/gather-state.sh (via lib.sh wrappers).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export type ArtifactKind = 'analysis' | 'brainstorm' | 'consensus' | 'missing' | 'malformed'

export type FenceResult = { state: 'none' } | { state: 'unterminated' } | { state: 'ok'; body: string }

const BACKUP_RE = /\.(orig|rej|bak)$|~$/

/** Strip UTF-8 BOM if present. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Opening/closing fence: line that is only `---` plus optional trailing
 * whitespace. CRLF is handled by split; a lone `\r` on the line is trimmed.
 * Opening must be line 1 (after BOM strip). No opening → `none` (legacy).
 * Opening without close → `unterminated` (fail-closed — never treat body as FM).
 */
export function extractFrontmatter(raw: string): FenceResult {
  const text = stripBom(raw)
  const lines = text.split(/\r?\n/)
  const first = (lines[0] ?? '').replace(/\r$/, '')
  if (!/^---\s*$/.test(first)) return { state: 'none' }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '')
    if (/^---\s*$/.test(line)) {
      return { state: 'ok', body: lines.slice(1, i).join('\n') }
    }
  }
  return { state: 'unterminated' }
}

/** Normalize a YAML scalar value: trailing comment, quotes, case for compare. */
export function normalizeYamlScalar(raw: string): string {
  let v = raw.replace(/\s+#.*$/, '').trim()
  if (
    (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
    (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
  ) {
    v = v.slice(1, -1)
  }
  return v.trim()
}

/**
 * Last-wins key lookup (YAML). Bash `head -1` was first-wins — an injected
 * earlier `status:` could override the real one; YAML agents write last.
 */
export function frontmatterKey(body: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'i')
  let found: string | undefined
  for (const line of body.split(/\r?\n/)) {
    const m = line.replace(/\r$/, '').match(re)
    if (m) found = normalizeYamlScalar(m[1] ?? '')
  }
  return found
}

export function classifyFromContent(raw: string): { kind: ArtifactKind; status: string } {
  const fence = extractFrontmatter(raw)
  if (fence.state === 'unterminated') {
    // Fail-closed: body must never be read as header (consensus/status injection).
    return { kind: 'malformed', status: '' }
  }
  if (fence.state === 'none') {
    // Legacy analyses with no frontmatter at all — still resolvable as analysis,
    // empty status ≡ approved for the pipeline gate.
    return { kind: 'analysis', status: '' }
  }

  const type = (frontmatterKey(fence.body, 'type') ?? '').toLowerCase()
  const status = (frontmatterKey(fence.body, 'status') ?? '').toLowerCase()

  if (type === 'brainstorm') return { kind: 'brainstorm', status }
  if (type === 'analysis') return { kind: 'analysis', status }
  if (status === 'consensus-reached') return { kind: 'consensus', status }
  return { kind: 'analysis', status }
}

export function classifyFile(path: string): { kind: ArtifactKind; status: string } {
  try {
    if (!statSync(path).isFile()) return { kind: 'missing', status: '' }
  } catch {
    return { kind: 'missing', status: '' }
  }
  if (BACKUP_RE.test(path)) return { kind: 'missing', status: '' }
  try {
    return classifyFromContent(readFileSync(path, 'utf8'))
  } catch {
    return { kind: 'missing', status: '' }
  }
}

export function artifactKind(path: string): ArtifactKind {
  return classifyFile(path).kind
}

export function artifactStatus(path: string): string {
  return classifyFile(path).status
}

/**
 * First file in dir that is name-matched (anchored N, else slug) AND kind=analysis.
 * Candidate order matches the previous bash: ls order for N matches, then slug.
 */
export function resolveAnalysis(dir: string, n: string, slug: string): string {
  let entries: string[]
  try {
    if (!statSync(dir).isDirectory()) return ''
    entries = readdirSync(dir)
  } catch {
    return ''
  }

  const candidates: string[] = []
  const seen = new Set<string>()

  if (n) {
    // Anchored: char before N is start or non-digit, then N-, so #4 ¬matches #14.
    const anchor = new RegExp(`(^|[^0-9])${escapeRegExp(n)}-`)
    for (const name of entries) {
      if (anchor.test(name) && !seen.has(name)) {
        seen.add(name)
        candidates.push(name)
      }
    }
  }
  if (slug) {
    const needle = slug.toLowerCase()
    for (const name of entries) {
      if (name.toLowerCase().includes(needle) && !seen.has(name)) {
        seen.add(name)
        candidates.push(name)
      }
    }
  }

  for (const name of candidates) {
    if (artifactKind(join(dir, name)) === 'analysis') return name
  }
  return ''
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── CLI (bash hooks) ─────────────────────────────────────────────────────────
//   bun artifact-classify.ts classify <path>           → kind|status
//   bun artifact-classify.ts kind <path>               → kind
//   bun artifact-classify.ts status <path>             → status
//   bun artifact-classify.ts resolve <dir> <N> <slug>  → filename or ""

function main(argv: string[]): void {
  const [cmd, ...rest] = argv
  switch (cmd) {
    case 'classify': {
      const path = rest[0] ?? ''
      const { kind, status } = classifyFile(path)
      process.stdout.write(`${kind}|${status}\n`)
      break
    }
    case 'kind': {
      process.stdout.write(`${artifactKind(rest[0] ?? '')}\n`)
      break
    }
    case 'status': {
      process.stdout.write(`${artifactStatus(rest[0] ?? '')}\n`)
      break
    }
    case 'resolve': {
      const [dir = '', n = '', slug = ''] = rest
      process.stdout.write(`${resolveAnalysis(dir, n, slug)}\n`)
      break
    }
    default: {
      process.stderr.write('usage: artifact-classify.ts classify|kind|status|resolve …\n')
      process.exit(2)
    }
  }
}

const isMain =
  typeof Bun !== 'undefined'
    ? Boolean(Bun.main) && import.meta.path === Bun.main
    : process.argv[1] !== undefined &&
      (process.argv[1].endsWith('artifact-classify.ts') || basename(process.argv[1]) === 'artifact-classify.ts')

if (isMain) {
  main(process.argv.slice(2))
}
