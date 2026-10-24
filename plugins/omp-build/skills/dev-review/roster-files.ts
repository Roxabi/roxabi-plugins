import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { STACK_YML } from '../../hooks/lib/contract-paths.cjs'

function errorCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const raw = err.code
    if (typeof raw === 'string') return raw
  }
  return ''
}

/** Every path here is operator-supplied (`--diff-list`, `--chunk-list`, `--spec`,
 *  `--stack`). `readFileSync` on a FIFO or a character device never returns, so
 *  the type precondition comes first: anything that is not a regular file falls
 *  into the same warning path as an unreadable one. */
export function readOrWarn(path: string, what: string, warnings?: string[]): string | null {
  try {
    if (!statSync(path).isFile()) {
      warnings?.push(`${what} unreadable: not a regular file`)
      return null
    }
    return readFileSync(path, 'utf-8')
  } catch (err) {
    const code = errorCode(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    const message = err instanceof Error ? err.message : String(err)
    warnings?.push(`${what} unreadable: ${message}`)
    return null
  }
}

// Legacy contract location: a presence probe, never a read path. Deliberately local
// (¬a resolver export) so no caller can ever read the contract from `.claude/`.
const LEGACY_STACK_YML = '.claude/stack.yml'

/** Absent stack ⇒ every roster override (max_agents, `agents: always|never`) is
 *  dropped in silence — a pinned `R-security-auditor: always` would just vanish.
 *  Warn instead, and name the gesture: move it, or write it. */
export function stackAbsenceWarning(stackPath: string): string | null {
  if (existsSync(stackPath)) return null
  if (stackPath.endsWith(STACK_YML)) {
    const legacy = stackPath.slice(0, -STACK_YML.length) + LEGACY_STACK_YML
    if (existsSync(legacy)) {
      return `${stackPath} not found but ${legacy} exists — legacy contract layout: move it to ${STACK_YML}; roster overrides ignored until then`
    }
  }
  return `${stackPath} not found — roster overrides ignored`
}

function dirOrWarn(dir: string, what: string, warnings?: string[]) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    const code = errorCode(err)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    const message = err instanceof Error ? err.message : String(err)
    warnings?.push(`${what} unreadable: ${message}`)
    return null
  }
}

export function hasAxialAdr(adrDir: string, warnings?: string[]): boolean {
  const entries = dirOrWarn(adrDir, 'axial ADR dir', warnings)
  if (!entries) return false
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const member = join(adrDir, e.name)
    const text = readOrWarn(member, member, warnings)
    if (text == null) continue
    if (/^axial:\s*true/m.test(text)) return true
  }
  return false
}
