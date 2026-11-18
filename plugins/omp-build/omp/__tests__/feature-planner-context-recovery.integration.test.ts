import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { canonicalValueDigest } from '../../engine/action-input.ts'
import { workflowContextResolution } from '../../engine/workflow-context-terminal.ts'
import { cleanupFeatureRecoveryRoots, featureFixture, SCOPE } from '../../testing/feature-recovery-fixture.ts'
import { git, readSim } from '../../testing/sandbox/sandbox-repository.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const RUNNER = path.resolve(import.meta.dirname, '../../testing/feature-planner-context-runner.ts')
afterEach(cleanupFeatureRecoveryRoots)

it.each(['plan', 'plan-review'] as const)(
  'recovers a genuine native %s negative through public preparation and positive native publication',
  (action) => {
    const { box, checkout } = featureFixture('mandate')
    const history = () =>
      decodeHistory({
        scope: SCOPE,
        expectedAuthor: 'operator',
        stopAuthor: null,
        complete: true,
        diagnostics: [],
        comments: (readSim(box).issues['42']?.comments ?? []).map((comment, index) => ({
          locator: `${SCOPE.target}:${index + 1}`,
          nativeId: String(index + 1),
          body: comment.body,
          author: comment.author,
          createdAt: comment.createdAt ?? null,
          updatedAt: comment.updatedAt ?? null,
        })),
      })
    expect(history().operations.some(({ record }) => record?.kind === 'spec-identity')).toBe(true)
    const run = (mode: string, actionFile = '') => {
      const child = spawnSync(BUN, [RUNNER, checkout, mode, actionFile], {
        cwd: checkout,
        env: box.env,
        encoding: 'utf8',
      })
      if (child.status !== 0) throw new Error(`planner runner failed: ${child.stderr}\n${child.stdout}`)
      return JSON.parse(child.stdout) as { admitted: boolean; tasks?: string[]; messages: string[] }
    }
    const first = run(action === 'plan-review' ? 'positive-then-negative' : 'negative')
    expect(first.admitted, JSON.stringify(first)).toBe(true)
    expect(first.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH'))).toHaveLength(
      action === 'plan' ? 1 : 2,
    )
    const negatives = history().operations.flatMap(({ record }) =>
      record?.kind === 'action-receipt' && record.payload.action === action && record.payload.phase === 'result'
        ? [record]
        : [],
    )
    expect(
      negatives,
      JSON.stringify({
        messages: first.messages,
        diagnostics: history().diagnostics,
        operations: history().operations.map(({ status, record, kind }) => ({
          status,
          kind,
          action: record?.kind === 'action-receipt' ? record.payload.action : undefined,
          phase: record?.kind === 'action-receipt' ? record.payload.phase : undefined,
        })),
      }),
    ).toHaveLength(1)
    const negative = negatives[0]
    if (
      negative?.payload.phase !== 'result' ||
      (negative.payload.action !== 'plan' && negative.payload.action !== 'plan-review')
    )
      throw new Error('native planner negative not published')
    expect(negative.payload.native).toMatchObject({ completion: 'completed', strict: 'valid' })
    expect(negative.payload.admission).toBeNull()
    const before = JSON.stringify(negative)
    const contributor =
      negative.payload.action === 'plan-review'
        ? negative.payload.contributions.find((item) => item.host.slotId === 'adversarial')
        : null
    const previous =
      negative.payload.action === 'plan-review' ? contributor?.host.action?.inputs : negative.payload.inputs
    if (!previous) throw new Error('negative contributor inputs missing')
    if (action === 'plan-review') expect(contributor?.host.role).toBe('R-workflow-plan-adversarial')
    const head = git(box, checkout, ['rev-parse', 'HEAD']).trim()
    const digest = createHash('sha256')
      .update(readFileSync(path.join(checkout, 'README.md')))
      .digest('hex')
    const negativeRef = {
      source: 'record' as const,
      record: { scope: SCOPE, kind: 'action-receipt' as const, recordId: negative.recordId },
      selector: '/payload',
      digest: canonicalValueDigest(negative.payload),
    }
    const actionFile = path.join(box.root, 'planner-expanded.json')
    writeFileSync(
      actionFile,
      JSON.stringify({
        request: {
          actionId: `expanded-${action}`,
          purpose: action,
          subject: previous.manifest.subject,
          code: previous.manifest.code,
          stageSources: previous.stageSources,
          expandedContext: [
            ...previous.manifest.expandedContext,
            negativeRef,
            { source: 'git-file', repository: SCOPE.repository, commit: head, path: 'README.md', digest },
          ],
        },
      }),
    )
    const recovered = run('positive', actionFile)
    expect(recovered.admitted, JSON.stringify(recovered)).toBe(true)
    expect(
      recovered.messages.filter((message) => message.includes('OMP_BUILD_NATIVE_BATCH')).length,
    ).toBeGreaterThanOrEqual(1)
    const current = history().operations.flatMap(({ record }) => (record === null ? [] : [record]))
    expect(JSON.stringify(current.find((record) => record.recordId === negative.recordId))).toBe(before)
    const starts = current.filter(
      (record) =>
        record.kind === 'action-receipt' &&
        record.payload.phase === 'start' &&
        (record.payload.action === 'plan' && action === 'plan'
          ? record.payload.actionId === 'expanded-plan'
          : record.payload.action === 'plan-review' &&
            action === 'plan-review' &&
            record.payload.slots.some(
              (slot) => slot.slotId === 'adversarial' && slot.action?.actionId === 'expanded-plan-review',
            )),
    )
    expect(starts).toHaveLength(1)
    const start = starts[0]
    if (start?.kind !== 'action-receipt') throw new Error('recovery start missing')
    const results = current.filter(
      (record) =>
        record.kind === 'action-receipt' &&
        record.payload.action === action &&
        record.payload.phase === 'result' &&
        record.payload.start.recordId === start.recordId,
    )
    expect(results).toHaveLength(1)
    const result = results[0]
    if (result?.kind !== 'action-receipt' || result.payload.phase !== 'result')
      throw new Error('recovery result missing')
    expect(result.payload.native).toMatchObject({ completion: 'completed', strict: 'valid' })
    if (result.payload.action === 'plan') expect(result.payload.structured).toMatchObject({ steps: expect.any(Array) })
    if (result.payload.action === 'plan-review')
      expect(result.payload.contributions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            host: expect.objectContaining({ slotId: 'adversarial' }),
            structured: { outcome: 'clear', blockers: [] },
          }),
        ]),
      )
    expect(workflowContextResolution(history(), negative)).toBe('clear')
    const comments = readSim(box).issues['42']?.comments.length
    expect(run('positive', actionFile).admitted).toBe(false)
    expect(readSim(box).issues['42']?.comments.length).toBe(comments)
  },
)
