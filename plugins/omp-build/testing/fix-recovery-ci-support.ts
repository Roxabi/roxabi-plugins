import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { pullHistory } from './feature-ci-review-fixture.ts'
import type { createRecoveryTestRoot } from './fix-recovery-real-root.ts'
import { runRecoveryReviewPrelude } from './fix-recovery-review-prelude.ts'
import { readSim, writeSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

export async function until<T>(read: () => T | undefined, name: string): Promise<T> {
  const end = Date.now() + 180_000
  while (Date.now() < end) {
    const value = read()
    if (value !== undefined) return value
    await delay(25)
  }
  throw new Error(`recovery-worker-timeout:${name}`)
}

export async function setupCiPrelude(box: Box, cwd: string, rootDir: string) {
  const review = await runRecoveryReviewPrelude({
    box,
    cwd,
    rootDir,
    credential: process.env.RECOVERY_TEST_CREDENTIAL ?? '',
    mode: 'healthy',
  })
  // A reproducible quality-policy failure, independent of the passing functional criterion.
  const quality = spawnSync('sh', ['-c', "grep -Eq ';$' src/save.ts"], { cwd, env: process.env, encoding: 'utf8' })
  if (quality.status !== 1 || quality.error)
    throw new Error(
      `recovery-worker-quality-check-unexpected:${JSON.stringify({ status: quality.status, error: quality.error, stderr: quality.stderr })}`,
    )
  const branch = readSim(box).prs['7']?.headRefName
  const head = branch === undefined ? undefined : box.sha[branch]
  if (!head) throw new Error('recovery-worker-ci-head-missing')
  writeSim(box, (state) => {
    state.checks[head] = [
      Object.assign(
        {
          name: 'semicolon-policy',
          status: 'completed',
          conclusion: 'failure',
          workflowName: 'quality',
          startedAt: '2026-10-22T12:00:00Z',
        },
        { id: 'quality-check-1' },
      ),
    ]
  })
  return { review, qualityStatus: quality.status }
}

export function readCiAttributionReceipt(box: Box) {
  return until(
    () =>
      pullHistory(box).operations.find(
        (item) =>
          item.status === 'complete' &&
          item.record?.kind === 'action-receipt' &&
          item.record.payload.phase === 'result' &&
          item.record.payload.action === 'attribute-ci',
      )?.record,
    'ci-attribution-receipt',
  )
}

export function yieldNative(
  messages: string,
  phase: string,
  probe: string,
  release: string,
): ReturnType<
  Extract<NonNullable<Parameters<typeof createRecoveryTestRoot>[0]['handler']>, (...args: never[]) => unknown>
> {
  if (phase === 'attribute') {
    if (!messages.includes('ci-attribution-probe')) {
      return {
        content: [
          {
            type: 'toolCall',
            id: 'ci-attribution-probe',
            name: 'bash',
            arguments: {
              command: `cat src/save.ts && if grep -Eq ';$' src/save.ts; then exit 1; else printf 'QUALITY_CHECK_FAILED\\n'; fi`,
            },
          },
        ],
      }
    }
    if (!messages.includes('QUALITY_CHECK_FAILED')) throw new Error('ci-attribution-probe-not-observed')
    return {
      content: [
        {
          type: 'toolCall',
          id: 'ci-attribution-yield',
          name: 'yield',
          arguments: { data: { attribution: 'change', evidence: null } },
        },
      ],
    }
  }
  if (!messages.includes('held-probe')) {
    return {
      content: [
        {
          type: 'toolCall',
          id: 'held-probe',
          name: 'bash',
          arguments: {
            command: `test -f src/save.ts && cat src/save.ts > '${probe}' && while [ ! -f '${release}' ]; do sleep 0.05; done`,
          },
        },
      ],
    }
  }
  return { content: [{ type: 'toolCall', id: 'held-yield', name: 'yield', arguments: { data: { findings: [] } } }] }
}
