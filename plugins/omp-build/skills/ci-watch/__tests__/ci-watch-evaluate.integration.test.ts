import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fixture,
  installGh,
  installProbeGh,
  page,
  plantBase,
  read,
  runWatch,
  snapshot,
  type WatchFixture,
} from './ci-watch-fixtures.ts'

const SINCE = '2026-09-29T10:00:00Z'
const EVALUATE_ONLY = 'evaluate-only: kit-ci App not configured — manual merge required (docs/kit/ci-app-setup.md)'
const EVALUATE_ONLY_LATEST =
  'evaluate-only: the latest merge-on-green run was evaluate-only — configure kit-ci (docs/kit/ci-app-setup.md), then re-label reviewed'
const NOT_CONFIGURED = JSON.stringify([
  { title: 'kit-ci not configured', message: 'Auto-merge OFF (evaluate-only)', annotation_level: 'notice' },
])
const MANUAL_MERGE = JSON.stringify([
  { title: 'Manual merge required', message: 'App X is not installed', annotation_level: 'warning' },
])
const OTHER_NOTICE = JSON.stringify([{ title: 'something else', message: 'x', annotation_level: 'notice' }])

function evaluate(box: WatchFixture, extra: string[] = ['--since', SINCE]) {
  return runWatch(box, { mode: 'merge-on-green', extra })
}

function count(box: WatchFixture, name: string): string {
  return read(box, `${name}.count`).trim()
}

describe('ci-watch merge-on-green evaluate-only probe', () => {
  it.each([
    ['Manual merge required', MANUAL_MERGE],
    ['kit-ci not configured', NOT_CONFIGURED],
  ])('exits 6 when the landing run reports %s', (_label, annotations) => {
    const box = fixture('evaluate-only')
    installProbeGh(box, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [page({ id: 42, status: 'completed', started_at: '2026-09-29T10:00:05Z' })],
      annotations: { 42: annotations },
    })
    const result = evaluate(box)
    expect(result.code).toBe(6)
    expect(result.stderr).toContain(EVALUATE_ONLY)
    expect(count(box, 'snap')).toBe('3')
    expect(read(box, 'api.log')).toContain('check-runs/42/annotations')
  })

  it('uses the re-label guidance when no --since boundary selected the landing', () => {
    const box = fixture('latest-evaluate-only')
    installProbeGh(box, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [page({ id: 42, status: 'completed', started_at: '2026-09-29T09:00:00Z' })],
      annotations: { 42: NOT_CONFIGURED },
    })
    const result = evaluate(box, [])
    expect(result.code).toBe(6)
    expect(result.stderr).toContain(EVALUATE_ONLY_LATEST)
    expect(result.stderr).not.toContain(EVALUATE_ONLY)
  })

  it.each([
    ['the exact UTC second', SINCE],
    ['a fraction in that UTC second', '2026-09-29T10:00:00.500Z'],
  ])('keeps a run started at %s', (_label, startedAt) => {
    const box = fixture('since-boundary')
    installProbeGh(box, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [page({ id: 42, status: 'completed', started_at: startedAt })],
      annotations: { 42: NOT_CONFIGURED },
    })
    const result = evaluate(box)
    expect(result.code).toBe(6)
    expect(result.stderr).toContain(EVALUATE_ONLY)
  })

  it('does not probe after a merged first merge-phase snapshot', () => {
    const box = fixture('already-merged')
    installProbeGh(box, {
      snapshots: [snapshot(), snapshot(), snapshot('MERGED')],
      runs: [page({ id: 42, status: 'completed', started_at: '2026-09-29T10:00:05Z' })],
      annotations: { 42: NOT_CONFIGURED },
    })
    const result = evaluate(box)
    expect(result.code).toBe(0)
    expect(read(box, 'api.log')).toBe('')
    expect(count(box, 'snap')).toBe('3')
  })

  it('fails internally when the check-runs lookup fails instead of waiting for its deadline', () => {
    const box = fixture('runs-fail')
    for (let index = 1; index <= 3; index += 1) writeFileSync(join(box.root, `snap.${index}.json`), snapshot())
    installGh(
      box,
      `#!/usr/bin/env bash
set -euo pipefail
d="$(dirname "$0")/.."
if [[ "$1" == "api" ]]; then echo "$*" >> "$d/api.log"; exit 1; fi
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  n=0; [[ -f "$d/snap.count" ]] && n=$(cat "$d/snap.count")
  n=$((n + 1)); echo "$n" > "$d/snap.count"
  cat "$d/snap.$n.json"; exit 0
fi
echo "unexpected gh command: $*" >&2
exit 70
`,
    )
    const result = evaluate(box)
    expect(result.code).toBe(70)
    expect(read(box, 'api.log')).toContain('commits/abc/check-runs')
    expect(count(box, 'snap')).toBe('3')
  })

  it('continues to merge after a completed run has no evaluate-only notice', () => {
    const box = fixture('configured')
    installProbeGh(box, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [page({ id: 42, status: 'completed', started_at: '2026-09-29T10:00:05Z' })],
      annotations: { 42: OTHER_NOTICE },
    })
    const result = evaluate(box)
    expect(result.code).toBe(0)
    expect(count(box, 'snap')).toBe('5')
    expect(count(box, 'runs')).toBe('1')
  })

  it('never judges a stale annotated run when a fresh configured run succeeds it', () => {
    const box = fixture('stale-run')
    const stale = { id: 41, status: 'completed', started_at: '2026-09-29T09:00:00Z' }
    installProbeGh(box, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [page(stale), page(stale, { id: 42, status: 'completed', started_at: '2026-09-29T10:00:07Z' })],
      annotations: { 41: NOT_CONFIGURED, 42: '[]' },
    })
    const result = evaluate(box)
    expect(result.code).toBe(0)
    expect(count(box, 'runs')).toBe('2')
    expect(read(box, 'api.log')).not.toContain('check-runs/41/annotations')
    expect(read(box, 'api.log')).toContain('check-runs/42/annotations')
  })

  it('keeps probing a queued run hidden by required checks until its notice resolves', () => {
    const box = fixture('queued')
    plantBase(box.cwd, { '.dev/stack.yml': 'landing:\n  required_checks: [ci]\n' })
    const queued = page({ id: 42, status: 'queued', started_at: '2026-09-29T10:00:05Z' })
    const open = snapshot('OPEN', { extraChecks: [{ name: 'merge-on-green', status: 'QUEUED', conclusion: '' }] })
    installProbeGh(box, {
      snapshots: [open],
      runs: [queued, queued, queued, page({ id: 42, status: 'completed', started_at: '2026-09-29T10:00:05Z' })],
      annotations: { 42: NOT_CONFIGURED },
    })
    const result = evaluate(box)
    expect(result.code).toBe(6)
    expect(result.stderr).toContain(EVALUATE_ONLY)
    expect(count(box, 'runs')).toBe('4')
  })

  it('does not let a newer skipped run hide the evaluated landing run', () => {
    const box = fixture('skipped-run')
    installProbeGh(box, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [
        page(
          { id: 42, status: 'completed', started_at: '2026-09-29T10:00:05Z' },
          { id: 43, status: 'completed', conclusion: 'skipped', started_at: '2026-09-29T10:00:09Z' },
        ),
      ],
      annotations: { 42: NOT_CONFIGURED, 43: '[]' },
    })
    expect(evaluate(box).code).toBe(6)
  })

  it('lets the newest non-skipped run decide without inspecting its older annotation', () => {
    const box = fixture('newest-run')
    installProbeGh(box, {
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot('MERGED')],
      runs: [
        page(
          { id: 44, status: 'completed', started_at: '2026-09-29T10:00:08Z' },
          { id: 42, status: 'completed', started_at: '2026-09-29T10:00:03Z' },
        ),
      ],
      annotations: { 42: NOT_CONFIGURED, 44: '[]' },
    })
    expect(evaluate(box).code).toBe(0)
    expect(read(box, 'api.log')).not.toContain('check-runs/42/annotations')
  })

  it('never probes in native mode even when an annotated run exists', () => {
    const box = fixture('native')
    const armed = snapshot('OPEN', { autoMergeRequest: { mergeMethod: 'MERGE' } })
    installProbeGh(box, {
      snapshots: [armed, armed, armed, snapshot('MERGED')],
      runs: [page({ id: 42, status: 'completed', started_at: '2026-09-29T10:00:05Z' })],
      annotations: { 42: NOT_CONFIGURED },
    })
    const result = runWatch(box, { mode: 'native', extra: ['--since', SINCE] })
    expect(result.code).toBe(0)
    expect(count(box, 'snap')).toBe('4')
    expect(read(box, 'api.log')).toBe('')
  })

  it('returns the internal outcome when annotations cannot be read', () => {
    const box = fixture('annotations-fail')
    installProbeGh(box, {
      snapshots: [snapshot()],
      runs: [page({ id: 42, status: 'completed', started_at: '2026-09-29T10:00:05Z' })],
    })
    const result = evaluate(box)
    expect(result.code).toBe(70)
    expect(read(box, 'api.log')).toContain('check-runs/42/annotations')
  })
})
