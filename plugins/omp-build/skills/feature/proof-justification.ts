import { isMap, NO_TEST_REASONS, type NoTestReason, type Refusal, refuse, STACK } from './proof-base'
import type { ChangeResult } from './proof-semctx-protocol'

// ---------------------------------------------------------------------------
// PARTIAL justification: the selected PR body
// ---------------------------------------------------------------------------

const ID_CHAR = String.raw`[\w.:/-]`
const NO_TEST_CELL = /^⚠\s*NO TEST\s*(?:—|--|-)\s*(.+?)\s*$/

/** The NO TEST reasons the body's table rows give `gap`, from the rows whose first cell names it. */
export function noTestReasons(body: string, gap: string): string[] {
  const named = new RegExp(`(?<!${ID_CHAR})${gap.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!${ID_CHAR})`)
  const reasons: string[] = []
  for (const line of body.split('\n')) {
    const row = line.trim()
    if (!row.startsWith('|') || !row.endsWith('|')) continue
    const cells = row
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim())
    if (!named.test(cells[0] ?? '')) continue
    const reason = (cells.at(-1) ?? '').match(NO_TEST_CELL)?.[1]
    if (reason !== undefined) reasons.push(reason)
  }
  return reasons
}

export type BrowserCheck = { steps: string; url: string; observed: string }

const BROWSER_FIELDS: Record<string, keyof BrowserCheck> = { steps: 'steps', url: 'url', observed: 'observed' }

/** The body's `Browser check <gap>` block (the gap bare or in backticks): its Steps, URL and Observed lines. */
export function browserCheck(body: string, gap: string): Partial<BrowserCheck> | null {
  const lines = body.split('\n')
  const heading = /^(?:#{1,6}\s*)?Browser check\s+(?:`([^`]+)`|([^\s`:]+))\s*:?\s*$/i
  const start = lines.findIndex((line) => {
    const match = line.trim().match(heading)
    return (match?.[1] ?? match?.[2]) === gap
  })
  if (start < 0) return null
  const out: Partial<BrowserCheck> = {}
  for (const line of lines.slice(start + 1)) {
    const text = line.trim()
    if (/^#{1,6}\s/.test(text) || heading.test(text)) break
    const field = text.match(/^[-*]\s*(Steps|URL|Observed)\s*:\s*(.*)$/i)
    const key = BROWSER_FIELDS[(field?.[1] ?? '').toLowerCase()]
    if (key) out[key] ??= field?.[2] ?? ''
  }
  return out
}

/** An http(s) URL. WHATWG parsing already rejects an http(s) URL with an empty host. */
function validUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Whether `.dev/stack.yml` text declares a non-blank `commands.test_e2e`. Throws on unreadable YAML. */
export function declaresE2e(stackText: string): boolean {
  if (!stackText.trim()) return false
  if (typeof Bun === 'undefined' || typeof Bun.YAML?.parse !== 'function') {
    throw new Error('reading .dev/stack.yml needs bun >= 1.2.21 (Bun.YAML)')
  }
  const doc = Bun.YAML.parse(stackText)
  if (doc == null) return false
  if (!isMap(doc)) throw new Error('the document is not a map')
  const commands = doc.commands
  if (commands == null) return false
  if (!isMap(commands)) throw new Error('commands is not a map')
  const e2e = commands.test_e2e
  return typeof e2e === 'string' ? e2e.trim().length > 0 : e2e != null
}

export type Justification = { gap: string; reason: NoTestReason }

function gapReason(body: string, change: string, gap: string): NoTestReason | Refusal {
  const reasons = [...new Set(noTestReasons(body, gap))]
  if (reasons.length === 0)
    return refuse('semctx', 'unjustified', `change ${change}: gap ${gap} has no NO TEST row in the PR body`)
  if (reasons.length > 1)
    return refuse(
      'semctx',
      'unjustified',
      `change ${change}: gap ${gap} has conflicting NO TEST rows (${reasons.join(', ')})`,
    )
  const written = reasons[0] ?? ''
  const reason = NO_TEST_REASONS.find((known) => known === written)
  if (!reason)
    return refuse(
      'semctx',
      'unjustified',
      `change ${change}: gap ${gap} gives NO TEST reason ${JSON.stringify(written)}, outside ${NO_TEST_REASONS.join(', ')}`,
    )
  return reason
}

function manualCheck(body: string, change: string, gap: string, e2e: () => boolean): Refusal | null {
  if (e2e())
    return refuse(
      'semctx',
      'unjustified',
      `change ${change}: gap ${gap} is ui-manual-only but ${STACK} on the base or the candidate declares commands.test_e2e — that command is the proof`,
    )
  const check = browserCheck(body, gap)
  const missing = [
    !check && 'the browser check block',
    check && !check.steps?.trim() && 'steps',
    check && !validUrl(check.url?.trim() ?? '') && 'a valid http(s) URL',
    check && !check.observed?.trim() && 'the observed result',
  ].filter(Boolean)
  if (missing.length)
    return refuse(
      'semctx',
      'unjustified',
      `change ${change}: ui-manual-only gap ${gap} lacks ${missing.join(', ')} in the PR body`,
    )
  return null
}

function justifyGap(body: string, change: string, gap: string, e2e: () => boolean): Justification | Refusal {
  const reason = gapReason(body, change, gap)
  if (typeof reason !== 'string') return reason
  if (reason === 'ui-manual-only') {
    const refusal = manualCheck(body, change, gap, e2e)
    if (refusal) return refusal
  }
  return { gap, reason }
}

/**
 * Every PARTIAL gap needs exactly one NO TEST reason from the closed enum in the
 * selected PR body. `ui-manual-only` is refused when the base or the candidate
 * commits an e2e command; otherwise the body carries that gap's browser check with nonblank
 * steps, an http(s) URL and a nonblank observed result.
 */
export function justifyGaps(results: ChangeResult[], body: string, e2e: () => boolean): Refusal | Justification[] {
  const out: Justification[] = []
  for (const result of results) {
    for (const gap of result.gaps) {
      const justification = justifyGap(body, result.id, gap, e2e)
      if ('ok' in justification) return justification
      out.push(justification)
    }
  }
  return out
}
