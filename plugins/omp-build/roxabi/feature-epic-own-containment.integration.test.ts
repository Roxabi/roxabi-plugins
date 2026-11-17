import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { resolveAcceptedSpec } from '../contracts.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from '../engine/__tests__/workflow-spec-assessment-support.ts'
import { actionInputDigest, validateActionInputs } from '../engine/action-input.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { authenticateCapturedWorkFrame } from '../engine/workflow-captured-frame.ts'
import { inspectContextNegativeReceipt } from '../engine/workflow-context-negative-inspection.ts'
import { recordsOf } from '../engine/workflow-control.ts'
import { nativeFeatureSpec } from '../testing/feature-review-fixture.ts'
import { git, readSim, writeSim } from '../testing/sandbox/sandbox-repository.ts'
import { evolveChildHistory } from './feature-containment-child-evolution-fixture.ts'
import { control, fixture, roots } from './feature-epic-own-containment-fixture.ts'
import { createInstalledUwReadPort } from './uw-read-port.ts'

const ASSESSMENT = path.resolve(import.meta.dirname, '../testing/feature-context-assessment-runner.ts')
const ABANDON = path.resolve(import.meta.dirname, './feature-containment-abandon-fixture.ts')
const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const ROOT = { repository: 'acme/app', target: 'acme/app#42' }
const CHILD = { repository: 'acme/app', target: 'acme/app#43' }
const BRANCH = 'feat/44-foreign'

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

describe('Epic own-lane containment through public controls', () => {
  it.each(['intact', 'incomplete', 'foreign'] as const)(
    'abandons an assessment-negative Epic only after accounting for its %s child PR ownership',
    async (ownership) => {
      const { box, cwd: originalCwd } = fixture('child')
      const worktreeRoot = path.join(box.root, 'context-worktrees')
      const cwd = path.join(worktreeRoot, 'app', 'parents', 'acme-42')
      mkdirSync(path.dirname(cwd), { recursive: true })
      git(box, box.principal, ['worktree', 'move', originalCwd, cwd])
      git(box, cwd, ['checkout', '--detach', '-q'])
      const gh = async (directory: string, args: string[]) =>
        execFileSync('gh', args, {
          cwd: directory,
          env: box.env,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
        })
      const reader = createInstalledUwReadPort({ cwd, gh, readAuthor: 'operator' })
      const before = ownership === 'intact' ? await reader.readUw(CHILD) : null
      const beforeChild = before?.histories.find((entry) => entry.source.scope.target === CHILD.target)
      const childMandate =
        beforeChild &&
        recordsOf(beforeChild).find((record) => record.kind === 'mandate' && record.recordId === 'child-mandate')
      let laterChildRecords: CanonicalRecord[] | undefined
      let laterChildVersion: string | undefined
      function prepareLaterChild() {
        if (before !== null) {
          if (childMandate?.kind !== 'mandate') throw new Error('Original child mandate unavailable')
          const original = mandateAssessmentState(childMandate)
          const laterSpec = nativeFeatureSpec(CHILD, 'deliver the child and preserve locale')
          const { format: _format, version: _version, ...content } = laterSpec.ownSpec.snapshot.spec
          const proposed = proposedAssessmentState(original, { body: laterSpec.body, content })
          const base = git(box, cwd, ['rev-parse', 'main']).trim()
          const head = git(box, cwd, ['rev-parse', 'HEAD']).trim()
          const assessed = assessFixture(
            childMandate,
            'child-later-material',
            original,
            proposed,
            'material',
            before.histories,
            undefined,
            undefined,
            { repository: ROOT.repository, base, head, referenceCommit: head },
          )
          const accepted = acceptMaterialFixture(childMandate, 'accept-child-later-material', assessed)
          laterChildRecords = [assessed.start, assessed.result, accepted]
          laterChildVersion = proposed.snapshot.spec.version
        }
      }
      prepareLaterChild()
      box.env.OMP_WORKTREE_DIR = worktreeRoot
      writeSim(box, (state) => {
        const issue = state.issues['42']
        if (!issue) throw new Error('Missing root issue')
        issue.body = nativeFeatureSpec(ROOT, 'deliver the epic and preserve its timezone').body
      })
      const assessment = spawnSync(BUN, [ASSESSMENT, cwd, '', '#42'], { cwd, env: box.env, encoding: 'utf8' })
      if (assessment.status !== 0)
        throw new Error(`Native assessment failed: ${assessment.stderr}\n${assessment.stdout}`)
      const assessmentResult = JSON.parse(assessment.stdout)
      expect(assessmentResult, JSON.stringify(assessmentResult)).toMatchObject({
        admitted: true,
        activeAfterSettlement: false,
        coverageEdits: 1,
      })
      const rootHistory = () =>
        decodeHistory({
          scope: ROOT,
          expectedAuthor: 'operator',
          stopAuthor: null,
          complete: true,
          diagnostics: [],
          comments: (readSim(box).issues['42']?.comments ?? []).map((comment, index) => ({
            locator: `${ROOT.target}:${index + 1}`,
            nativeId: String(index + 1),
            body: comment.body,
            author: comment.author,
            createdAt: comment.createdAt ?? null,
            updatedAt: comment.updatedAt ?? null,
          })),
        })
      const negative = rootHistory().operations.find(
        ({ record }) =>
          record?.kind === 'action-receipt' &&
          record.payload.action === 'assess-spec' &&
          record.payload.phase === 'result' &&
          record.payload.structured !== null &&
          'outcome' in record.payload.structured &&
          record.payload.structured.outcome === 'missing-context',
      )?.record
      if (!negative) throw new Error('Native assessment negative unavailable')
      const negativeRecordId = negative.recordId
      async function assertIntactFrame() {
        if (ownership !== 'intact') return
        const read = await reader.readUw(ROOT)
        expect(read.observation.status).toBe('complete')
        const histories = read.observation.histories
        const home = histories.find((entry) => entry.source.scope.target === ROOT.target)
        const child = histories.find((entry) => entry.source.scope.target === CHILD.target)
        const mandate =
          home && recordsOf(home).find((record) => record.kind === 'mandate' && record.recordId === 'root-mandate')
        const nativeNegative = home && recordsOf(home).find((record) => record.recordId === negativeRecordId)
        if (
          mandate?.kind !== 'mandate' ||
          nativeNegative?.kind !== 'action-receipt' ||
          nativeNegative.payload.action !== 'assess-spec' ||
          nativeNegative.payload.phase !== 'result' ||
          !child
        )
          throw new Error('Observed assessment frame unavailable')
        function inspectMandate(verifiedMandate: Extract<CanonicalRecord, { kind: 'mandate' }>) {
          const inspected = inspectContextNegativeReceipt({ mandate: verifiedMandate, histories })
          if (!inspected.ok) throw new Error(`Native negative inspection refused: ${JSON.stringify(inspected)}`)
          return inspected.value.inspection
        }
        const inspection = inspectMandate(mandate)
        const inputs = nativeNegative.payload.inputs
        function findChildPin() {
          const pin = inputs.manifest.acceptedSources.find(
            (source) =>
              source.record.scope.target === CHILD.target &&
              source.record.scope.repository === CHILD.repository &&
              source.record.kind === 'mandate',
          )
          if (!pin) throw new Error('Managed child source pin unavailable')
          return pin
        }
        const pin = findChildPin()
        const frame = authenticateCapturedWorkFrame(inputs, inspection.mandate, histories, undefined, inspection)
        expect(frame, JSON.stringify(frame.ok ? { ok: true } : frame)).toMatchObject({ ok: true })
        function assertEvolvedChild(childHistory: NonNullable<typeof child>) {
          if (!laterChildRecords || !laterChildVersion || childMandate?.kind !== 'mandate')
            throw new Error('Later child material fixture unavailable')
          const evolvedHistories = evolveChildHistory(childHistory, histories, laterChildRecords)
          const evolvedAccepted = resolveAcceptedSpec(childMandate, evolvedHistories, undefined, inspection)
          expect(evolvedAccepted, JSON.stringify(evolvedAccepted)).toMatchObject({
            ok: true,
            spec: { ref: { version: laterChildVersion } },
          })
          expect(laterChildVersion).not.toBe(childMandate.payload.ownSpec.version)
          const operands = inputs.manifest.operands
          if (operands?.action !== 'assess-spec') throw new Error('Captured assessment operands unavailable')
          expect(
            operands.exactInputs.childOwnSources.find((source) => source.uw.target === CHILD.target)?.own?.version,
          ).toBe(childMandate.payload.ownSpec.version)
          const historicalFrame = authenticateCapturedWorkFrame(
            inputs,
            inspection.mandate,
            evolvedHistories,
            undefined,
            inspection,
          )
          expect(historicalFrame, JSON.stringify(historicalFrame.ok ? { ok: true } : historicalFrame)).toMatchObject({
            ok: true,
          })
        }
        assertEvolvedChild(child)
        function assertMissingAndForeignPins(
          childHistory: NonNullable<typeof child>,
          acceptedPin: NonNullable<typeof pin>,
        ) {
          const manifest = {
            ...inputs.manifest,
            acceptedSources: inputs.manifest.acceptedSources.filter((source) => source !== acceptedPin),
          }
          const missing = { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
          expect(validateActionInputs(missing).ok).toBe(true)
          expect(
            authenticateCapturedWorkFrame(missing, inspection.mandate, histories, undefined, inspection),
          ).toMatchObject({
            ok: false,
            diagnostics: expect.arrayContaining([
              expect.objectContaining({ message: 'Captured accepted metadata prefix is absent or ambiguous' }),
            ]),
          })
          const childOperation = childHistory.operations.find(
            (operation) =>
              operation.recordId === acceptedPin.record.recordId && operation.kind === acceptedPin.record.kind,
          )
          if (!childOperation || childOperation.parts.length === 0)
            throw new Error('Pinned child operation unavailable')
          const childPartIds = new Set(childOperation.parts.map((part) => part.nativeId))
          const foreignChild = decodeHistory({
            ...childHistory.source,
            comments: childHistory.source.comments.map((comment) =>
              childPartIds.has(comment.nativeId) ? { ...comment, author: 'intruder' } : comment,
            ),
          })
          expect(
            foreignChild.operations.find((operation) => operation.recordId === acceptedPin.record.recordId)?.authority,
          ).toBe('foreign')
          const foreignHistories = histories.map((entry) => (entry === childHistory ? foreignChild : entry))
          expect(
            authenticateCapturedWorkFrame(inputs, inspection.mandate, foreignHistories, undefined, inspection),
          ).toMatchObject({ ok: false })
        }
        assertMissingAndForeignPins(child, pin)
      }
      await assertIntactFrame()
      const retained = JSON.stringify(negative)
      if (ownership !== 'intact')
        writeSim(box, (state) => {
          const binding = state.prs['7']?.comments.find((comment) => comment.body.includes('kind=workflow-binding '))
          if (!binding) throw new Error('Child PR binding unavailable')
          if (ownership === 'foreign') binding.author = 'intruder'
          else binding.body = binding.body.replace(/part=1\/[0-9]+/, 'part=1/999')
        })
      if (ownership === 'intact') {
        const result = control(box, cwd, 'abandon', true)
        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'abandoned', confirmed: true })
        expect(readSim(box).prs['7']).toMatchObject({ labels: [], autoMerge: null })
      } else {
        const home = path.join(box.root, 'home-refused-abandon')
        mkdirSync(home, { recursive: true })
        const refused = spawnSync(BUN, [ABANDON, cwd, home, 'root'], {
          cwd,
          env: { ...box.env, HOME: home },
          encoding: 'utf8',
        })
        expect(refused.status).not.toBe(0)
        expect(readSim(box).prs['7']).toMatchObject({
          labels: ['reviewed'],
          autoMerge: { enabledAt: '2026-01-01T00:00:00Z' },
        })
        expect(
          rootHistory().operations.some(
            ({ record }) =>
              record?.kind === 'operator-control' &&
              record.payload.control === 'abandon' &&
              record.payload.mandate.recordId === 'root-mandate',
          ),
        ).toBe(false)
      }
      expect(
        JSON.stringify(rootHistory().operations.find(({ record }) => record?.recordId === negative.recordId)?.record),
      ).toBe(retained)
    },
    120_000,
  )

  it.each<'pause' | 'abandon'>(['pause', 'abandon'])(
    '%s does not disarm a foreign bound PR merely linked to the Epic',
    (action) => {
      const { box, cwd } = fixture('foreign')
      const result = control(box, cwd, action)
      const state = readSim(box)
      expect(state.prs['7']).toMatchObject({ labels: ['reviewed'], autoMerge: { enabledAt: '2026-01-01T00:00:00Z' } })
      expect(state.calls.filter((args) => args[0] === 'pr' && (args[1] === 'merge' || args[1] === 'edit'))).toEqual([])
      expect(result).toMatchObject({ kind: action === 'pause' ? 'paused' : 'abandoned', confirmed: false })
    },
  )

  it.each<'pause' | 'abandon'>(['pause', 'abandon'])(
    '%s does not disarm a foreign bound PR after the Epic becomes a Feature',
    (action) => {
      const { box, cwd } = fixture('foreign', true)
      const result = control(box, cwd, action)
      const state = readSim(box)
      expect(state.prs['7']).toMatchObject({
        state: 'OPEN',
        headRefName: BRANCH,
        labels: ['reviewed'],
        autoMerge: { enabledAt: '2026-01-01T00:00:00Z' },
      })
      expect(state.calls.filter((args) => args[0] === 'pr' && (args[1] === 'merge' || args[1] === 'edit'))).toEqual([])
      expect(result).toMatchObject({ kind: action === 'pause' ? 'paused' : 'abandoned', confirmed: false })
    },
  )

  it.each(
    (['pause', 'abandon'] as const).flatMap((action) =>
      [false, true].map((historicalEpic) => ({ action, historicalEpic })),
    ),
  )(
    '$action disarms an own PR after accepted-parent transition (returned to leaf: $historicalEpic)',
    ({ action, historicalEpic }) => {
      const { box, cwd } = fixture('selected', historicalEpic)
      const result = control(box, cwd, action, action === 'abandon')
      const state = readSim(box)
      expect(result, JSON.stringify(result)).toMatchObject({
        kind: action === 'pause' ? 'paused' : 'abandoned',
        confirmed: true,
      })
      expect(state.prs['7']).toMatchObject({ labels: [], autoMerge: null })
      expect(state.calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining(['pr', 'merge', '7', '--disable-auto']),
          expect.arrayContaining(['pr', 'edit', '7', '--remove-label', 'reviewed']),
        ]),
      )
    },
  )

  it.each(
    (['pause', 'abandon'] as const).flatMap((action) =>
      (['42', '43'] as const).flatMap((home) =>
        (['legacy', 'copy'] as const).map((claim) => ({ action, home, claim })),
      ),
    ),
  )('$action disarms own PR despite foreign $claim mandate on home $home', ({ action, home, claim }) => {
    const { box, cwd } = fixture('selected')
    writeSim(box, (state) => {
      const issue = state.issues[home]
      if (!issue) throw new Error('missing issue fixture')
      const bodies =
        claim === 'legacy'
          ? ['<!-- omp-build:mandate -->']
          : issue.comments.filter((entry) => entry.body.includes('kind=mandate ')).map((entry) => entry.body)
      if (bodies.length === 0) throw new Error('missing mandate copy fixture')
      issue.comments.push(...bodies.map((body) => ({ author: 'intruder', body })))
    })
    const result = control(box, cwd, action, action === 'abandon')
    const state = readSim(box)
    expect(result).toMatchObject({ kind: action === 'pause' ? 'paused' : 'abandoned', confirmed: true })
    expect(state.prs['7']).toMatchObject({ labels: [], autoMerge: null })
    expect(state.calls).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['pr', 'merge', '7', '--disable-auto']),
        expect.arrayContaining(['pr', 'edit', '7', '--remove-label', 'reviewed']),
      ]),
    )
  })

  it.each(['pause', 'abandon'] as const)('%s refuses an edited home without publishing or disarming', (action) => {
    const { box, cwd } = fixture('selected')
    writeSim(box, (state) => {
      const comment = state.issues['42']?.comments.find((entry) => entry.body.includes('kind=mandate '))
      if (!comment) throw new Error('missing root mandate')
      comment.createdAt = '2026-01-01T00:00:00Z'
      comment.updatedAt = '2026-01-01T00:00:01Z'
    })
    const before = readSim(box).issues['42']?.comments.map(({ author, body }) => ({ author, body }))
    const result = control(box, cwd, action)
    const state = readSim(box)
    expect(result).toMatchObject({ kind: 'blocked', reason: `${action}-uncertain` })
    expect(state.issues['42']?.comments.map(({ author, body }) => ({ author, body }))).toEqual(before)
    expect(
      state.calls.filter((args) => args[0] === 'api' && args.includes('--method') && args.includes('POST')),
    ).toEqual([])
    expect(state.prs['7']).toMatchObject({ labels: ['reviewed'], autoMerge: { enabledAt: '2026-01-01T00:00:00Z' } })
    expect(state.calls.filter((args) => args[0] === 'pr' && (args[1] === 'merge' || args[1] === 'edit'))).toEqual([])
  })

  it('refuses pause on an uncovered legacy mandate without publication or false confirmation', () => {
    const { box, cwd } = fixture('selected', false, true)
    const before = readSim(box).issues['42']?.comments.map(({ author, body }) => ({ author, body }))
    const result = control(box, cwd, 'pause')
    const state = readSim(box)
    expect(result).toMatchObject({ kind: 'blocked', reason: 'pause-uncertain' })
    expect(state.issues['42']?.comments.map(({ author, body }) => ({ author, body }))).toEqual(before)
    expect(
      state.calls.filter((args) => args[0] === 'api' && args.includes('--method') && args.includes('POST')),
    ).toEqual([])
    expect(state.prs['7']).toMatchObject({ labels: ['reviewed'], autoMerge: { enabledAt: '2026-01-01T00:00:00Z' } })
    expect(state.calls.filter((args) => args[0] === 'pr' && (args[1] === 'merge' || args[1] === 'edit'))).toEqual([])
  })
})
