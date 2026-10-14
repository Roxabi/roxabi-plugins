import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The pure merge-state classifier is exercised through the SAME code path the watch loop runs
// (ci-watch.sh --classify-merge-state), so a mis-bucketing here is a mis-bucketing in production
// — closing the coverage gap on the #344 state machine (F8). No gh/jq/network: the test hook is
// dispatched before the dependency check.
const CI_WATCH = fileURLToPath(new URL('../ci-watch.sh', import.meta.url))

/** classify_merge_state(state, mss, automerge, elapsed, timeout) → verdict token. */
function classify(state: string, mss: string, automerge: string, elapsed: number, timeout: number): string {
  const r = spawnSync(
    'bash',
    [CI_WATCH, '--classify-merge-state', state, mss, automerge, String(elapsed), String(timeout)],
    {
      encoding: 'utf-8',
    },
  )
  expect(r.status).toBe(0)
  return r.stdout.trim()
}

describe('classify_merge_state — verdict per (state, mergeStateStatus, automerge, elapsed, timeout)', () => {
  it('MERGED wins over everything (even DIRTY / auto-merge off / past timeout)', () => {
    expect(classify('MERGED', 'CLEAN', 'true', 0, 900)).toBe('MERGED')
    expect(classify('MERGED', 'DIRTY', 'false', 5000, 900)).toBe('MERGED')
  })

  it('CLOSED → UNMERGED_CLOSED (before the auto-merge-disabled check)', () => {
    expect(classify('CLOSED', 'UNKNOWN', 'false', 0, 900)).toBe('UNMERGED_CLOSED')
  })

  it('open + auto-merge disabled → UNMERGED_DISABLED', () => {
    expect(classify('OPEN', 'BLOCKED', 'false', 0, 900)).toBe('UNMERGED_DISABLED')
  })

  it('open + auto-merge on + past budget → UNMERGED_TIMEOUT', () => {
    expect(classify('OPEN', 'BLOCKED', 'true', 900, 900)).toBe('UNMERGED_TIMEOUT')
    expect(classify('OPEN', 'BLOCKED', 'true', 901, 900)).toBe('UNMERGED_TIMEOUT')
  })

  it('open + auto-merge on + within budget + DIRTY → UNMERGED_DIRTY (needs a human)', () => {
    expect(classify('OPEN', 'DIRTY', 'true', 10, 900)).toBe('UNMERGED_DIRTY')
  })

  it.each(['BEHIND', 'BLOCKED', 'UNSTABLE', 'CLEAN', 'UNKNOWN'])(
    'open + auto-merge on + within budget + %s → WATCH (transient / non-required, keep polling)',
    (mss) => {
      expect(classify('OPEN', mss, 'true', 10, 900)).toBe('WATCH')
    },
  )

  it('BEHIND/BLOCKED are NOT terminal — the #344 regression this locks against', () => {
    // Pre-#344 these returned "stop watch"; they must now keep polling.
    expect(classify('OPEN', 'BEHIND', 'true', 0, 900)).toBe('WATCH')
    expect(classify('OPEN', 'BLOCKED', 'true', 0, 900)).toBe('WATCH')
  })
})
