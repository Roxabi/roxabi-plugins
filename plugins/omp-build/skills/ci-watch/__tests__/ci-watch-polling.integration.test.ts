import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fixture,
  installGh,
  installProbeGh,
  plantBase,
  read,
  runWatch,
  startWatch,
  type WatchFixture,
  waitFor,
} from './ci-watch-fixtures.ts'

const PENDING = { name: 'ci', status: 'IN_PROGRESS', conclusion: '' }
const GREEN = { name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }
const FAILED = { name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }

function pr(state: string, checks: readonly unknown[], extra = {}): string {
  return JSON.stringify({
    state,
    mergeStateStatus: state === 'OPEN' ? 'BLOCKED' : 'UNKNOWN',
    autoMergeRequest: null,
    labels: state === 'OPEN' ? [{ name: 'reviewed' }] : [],
    headRefOid: 'abc',
    statusCheckRollup: checks,
    ...extra,
  })
}

function staticGh(box: WatchFixture, body: string, runList = 0): void {
  installGh(
    box,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "pr" && "$2" == "view" ]]; then cat <<'EOF'
${body}
EOF
exit 0
fi
if [[ "$1" == "run" && "$2" == "list" ]]; then exit ${runList}; fi
if [[ "$1" == "run" && "$2" == "view" ]]; then exit 0; fi
if [[ "$1" == "api" ]]; then echo '{"check_runs":[]}'; exit 0; fi
echo "unexpected gh command: $*" >&2
exit 70
`,
  )
}

function closeOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
  child.once('close', (code, signal) => resolve({ code, signal }))
  return promise
}

describe('ci-watch polling outcomes', () => {
  it('reports a closed PR during checks, rather than waiting for the deadline', () => {
    const box = fixture('closed')
    installProbeGh(box, { snapshots: [pr('CLOSED', [PENDING])] })
    const result = runWatch(box, { timeout: '2s', mode: 'native' })
    expect(result.code).toBe(4)
    expect(result.stdout.trim()).toBe('closed')
    expect(read(box, 'snap.count')).toBe('1')
  })

  it('returns merged from the first check-phase snapshot without a merge probe', () => {
    const box = fixture('merged-check-phase')
    installProbeGh(box, { snapshots: [pr('MERGED', [PENDING])] })
    const result = runWatch(box, { mode: 'native' })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('merged')
    expect(read(box, 'snap.count')).toBe('1')
    expect(read(box, 'api.log')).toBe('')
  })

  it('parses a leading-zero timeout as decimal seconds', () => {
    const box = fixture('leading-zero')
    installProbeGh(box, { snapshots: [pr('OPEN', [PENDING], { autoMergeRequest: { enabledAt: 't' } })] })
    expect(runWatch(box, { timeout: '09', mode: 'native' }).code).toBe(5)
  })

  it('observes a late pending run after green before reporting the merge', () => {
    const box = fixture('late-run')
    installProbeGh(box, {
      snapshots: [
        pr('OPEN', [GREEN]),
        pr('OPEN', [GREEN, { name: 'scan', status: 'IN_PROGRESS', conclusion: '' }]),
        pr('OPEN', [GREEN, { name: 'scan', status: 'COMPLETED', conclusion: 'SUCCESS' }]),
        pr('MERGED', [GREEN]),
      ],
    })
    const result = runWatch(box)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('merged')
    expect(read(box, 'snap.count')).toBe('4')
  })

  it('exits 1 for a failed check and prints its independent name and conclusion', () => {
    const box = fixture('failed')
    staticGh(box, pr('OPEN', [FAILED, { name: 'skip', status: 'COMPLETED', conclusion: 'SKIPPED' }]))
    const result = runWatch(box)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ci=FAILURE')
    expect(result.stderr).not.toContain('skip=SKIPPED')
  })

  it('applies every check when the base explicitly has no required-check list', () => {
    const box = fixture('no-required-checks')
    plantBase(box.cwd, { '.dev/stack.yml': 'landing:\n  required_checks: []\n' })
    staticGh(box, pr('OPEN', [FAILED]))
    const result = runWatch(box)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ci=FAILURE')
  })

  it.each([
    ['pending before deadline', [PENDING], '30s'],
    ['pending after deadline', [PENDING], '0s'],
    ['green after deadline', [GREEN], '0s'],
    ['failed checks', [FAILED], '30s'],
  ] as const)('stops an OPEN behind PR with %s before any watch outcome', (_label, checks, timeout) => {
    const box = fixture('behind')
    installProbeGh(box, { snapshots: [pr('OPEN', checks, { mergeStateStatus: 'BEHIND' })] })
    const result = runWatch(box, { timeout })
    expect(result.code).toBe(7)
    expect(result.stderr).toContain('gh pr update-branch 7')
    expect(result.stderr).not.toContain('undetermined')
    expect(read(box, 'snap.count')).toBe('1')
  })

  it('stops when a merge-phase snapshot becomes behind', () => {
    const box = fixture('behind-merge')
    const armed = { autoMergeRequest: { enabledAt: 't' }, labels: [] }
    installProbeGh(box, {
      snapshots: [
        pr('OPEN', [GREEN], armed),
        pr('OPEN', [GREEN], armed),
        pr('OPEN', [GREEN], { ...armed, mergeStateStatus: 'BEHIND' }),
      ],
    })
    const result = runWatch(box, { mode: 'native' })
    expect(result.code).toBe(7)
    expect(result.stderr).toContain('gh pr update-branch 7')
  })

  it('does not fall through to native eligibility when merge-on-green labels are malformed', () => {
    const box = fixture('malformed-labels')
    const malformed = JSON.stringify({
      state: 'OPEN',
      mergeStateStatus: 'BLOCKED',
      autoMergeRequest: null,
      labels: 1,
      headRefOid: 'abc',
      statusCheckRollup: [GREEN],
    })
    installProbeGh(box, { snapshots: [pr('OPEN', [GREEN]), pr('OPEN', [GREEN]), malformed] })
    expect(runWatch(box).code).toBe(70)
  })

  it('keeps an unarmed native behind PR as the behind refusal', () => {
    const box = fixture('behind-unarmed')
    installProbeGh(box, { snapshots: [pr('OPEN', [GREEN], { mergeStateStatus: 'BEHIND', labels: [] })] })
    expect(runWatch(box, { mode: 'native' }).code).toBe(7)
  })

  it('keeps blocked pending checks at their deadline exit', () => {
    const box = fixture('deadline')
    installProbeGh(box, { snapshots: [pr('OPEN', [PENDING])] })
    const result = runWatch(box, { timeout: '0s' })
    expect(result.code).toBe(5)
    expect(result.stderr).toContain('undetermined')
  })

  it.each([
    ['MERGED', 0],
    ['CLOSED', 4],
  ] as const)('keeps terminal %s ahead of a BEHIND merge state', (state, code) => {
    const box = fixture('behind-terminal')
    installProbeGh(box, { snapshots: [pr(state, [GREEN], { mergeStateStatus: 'BEHIND' })] })
    expect(runWatch(box).code).toBe(code)
  })

  it('requires a second green poll and keeps skipped work beside a pending check', () => {
    const box = fixture('skipped')
    const skipped = { name: 'Update behind PRs', status: 'COMPLETED', conclusion: 'SKIPPED' }
    installProbeGh(box, {
      snapshots: [
        pr('OPEN', [PENDING, skipped]),
        pr('OPEN', [GREEN, skipped]),
        pr('OPEN', [GREEN, skipped]),
        pr('OPEN', [GREEN, skipped], { mergeStateStatus: 'DIRTY' }),
      ],
    })
    const result = runWatch(box, { timeout: '2s' })
    expect(result.code).toBe(4)
    expect(read(box, 'snap.count')).toBe('4')
  })

  it.each([
    ['SKIPPED', 'skipped'],
    ['NEUTRAL', 'neutral'],
  ] as const)('treats required lint %s as green and ignores an unrequired failed scan', (conclusion, label) => {
    const box = fixture(`required-${label}`)
    plantBase(box.cwd, { '.dev/stack.yml': 'landing:\n  required_checks:\n    - lint\n' })
    const lint = { name: 'lint', status: 'COMPLETED', conclusion }
    const scan = { name: 'scan', status: 'COMPLETED', conclusion: 'FAILURE' }
    installProbeGh(box, { snapshots: [pr('OPEN', [lint, scan]), pr('OPEN', [lint, scan]), pr('MERGED', [lint])] })
    const result = runWatch(box)
    expect(result.code).toBe(0)
    expect(read(box, 'snap.count')).toBe('3')
  })

  it('prints failed-run unavailability without losing the failed-check exit', () => {
    const box = fixture('run-list-failure')
    staticGh(box, pr('OPEN', [FAILED]), 1)
    const result = runWatch(box)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ci=FAILURE')
    expect(result.stderr).toContain('failed-run logs unavailable')
  })

  it.each([
    ['CANCELLED', 2, 'ci=CANCELLED'],
    ['ACTION_REQUIRED', 3, 'ci=ACTION_REQUIRED'],
  ] as const)('%s returns exit %i and names its conclusion', (conclusion, code, expected) => {
    const box = fixture(`terminal-${code}`)
    staticGh(
      box,
      pr('OPEN', [
        { name: 'ci', status: 'COMPLETED', conclusion },
        { name: 'skip', status: 'COMPLETED', conclusion: 'SKIPPED' },
      ]),
    )
    const result = runWatch(box)
    expect(result.code).toBe(code)
    expect(result.stderr).toContain(expected)
    expect(result.stderr).not.toContain('skip=SKIPPED')
  })

  it('prints every non-passing unknown conclusion, not passing checks', () => {
    const box = fixture('other')
    staticGh(
      box,
      pr('OPEN', [
        GREEN,
        { name: 'rules', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
        { name: 'policy', status: 'COMPLETED', conclusion: 'STALE' },
      ]),
    )
    const result = runWatch(box)
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('rules=ACTION_REQUIRED')
    expect(result.stderr).toContain('policy=STALE')
    expect(result.stderr).not.toContain('ci=SUCCESS')
  })

  it('prints a status-context state rather than an empty unknown conclusion', () => {
    const box = fixture('status-context')
    staticGh(box, pr('OPEN', [{ context: 'coverage', state: 'BLOCKED' }]))
    const result = runWatch(box)
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('coverage=BLOCKED')
    expect(
      result.stderr
        .split('\n')
        .filter(Boolean)
        .every((line) => !line.endsWith('=')),
    ).toBe(true)
  })

  it('refuses malformed and empty snapshots as an internal outcome', () => {
    const malformed = fixture('malformed')
    installGh(malformed, '#!/usr/bin/env bash\necho "{"\n')
    const empty = fixture('empty')
    installGh(
      empty,
      '#!/usr/bin/env bash\nif [[ "$1" == "pr" ]]; then exit 0; fi\necho "unexpected gh command: $*" >&2\nexit 70\n',
    )
    expect(runWatch(malformed).code).toBe(70)
    const started = Date.now()
    const result = runWatch(empty, { timeout: '2s' })
    expect(result.code).toBe(70)
    expect(result.stderr).toContain('empty gh pr view')
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it('resolves merge-on-green from the base ref, never its unreviewed native fallback', () => {
    const box = fixture('base-mode')
    plantBase(box.cwd, { '.github/workflows/merge-on-green.yml': 'name: merge-on-green\n' })
    installProbeGh(box, {
      snapshots: [
        pr('OPEN', [GREEN], { autoMergeRequest: { mergeMethod: 'MERGE' }, labels: [] }),
        pr('OPEN', [GREEN], { autoMergeRequest: { mergeMethod: 'MERGE' }, labels: [] }),
      ],
    })
    expect(runWatch(box, { mode: null }).code).toBe(4)
  })

  it('refuses invalid stack YAML and invalid --since before a GitHub request', () => {
    const stack = fixture('invalid-stack')
    plantBase(stack.cwd, { '.dev/stack.yml': 'landing: [unclosed\n' })
    installGh(stack, '#!/usr/bin/env bash\necho "$*" >> "$(dirname "$0")/../gh.log"\nexit 70\n')
    const stackResult = runWatch(stack)
    expect(stackResult.code).toBe(70)
    expect(stackResult.stderr).toContain('not valid YAML')
    expect(read(stack, 'gh.log')).toBe('')
    const since = fixture('invalid-since')
    installGh(since, '#!/usr/bin/env bash\necho "$*" >> "$(dirname "$0")/../gh.log"\nexit 70\n')
    expect(runWatch(since, { extra: ['--since', '2026-09-29T10:00:00.123Z'] }).code).toBe(70)
    expect(read(since, 'gh.log')).toBe('')
    const missing = fixture('missing-since')
    installGh(missing, '#!/usr/bin/env bash\necho "$*" >> "$(dirname "$0")/../gh.log"\nexit 70\n')
    expect(runWatch(missing, { extra: ['--since'] }).code).toBe(70)
    expect(read(missing, 'gh.log')).toBe('')
  })

  it('exposes a real pending poll to SIGTERM without fabricating a terminal verdict', async () => {
    const box = fixture('signal')
    installProbeGh(box, { snapshots: [pr('OPEN', [PENDING])] })
    const child = startWatch(box, { interval: '1' })
    try {
      await waitFor(join(box.root, 'snap.count'), '1')
      child.kill('SIGTERM')
      const result = await closeOf(child)
      expect(result.code).toBeNull()
      expect(result.signal).toBe('SIGTERM')
      expect(read(box, 'snap.count')).toBe('1')
    } finally {
      child.kill('SIGKILL')
    }
  })
})
