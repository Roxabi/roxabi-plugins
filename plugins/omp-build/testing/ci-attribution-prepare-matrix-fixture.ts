import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import { canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { DecodedHistory, OperationRead } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { accounted } from '../engine/review-context-authentication.ts'
import type { ActionReceiptPayload } from '../engine/workflow-receipt-schema.ts'
import type { RecordInputRef, UwActionRequest } from '../roxabi/uw-action-contract.ts'
import { appendApprovedReview, pullHistory, setFailedCi } from './feature-ci-review-fixture.ts'
import { arrangeReviewFixture, seedReviewFixture } from './feature-review-fixture.ts'
import { isolatedPinSandbox } from './isolated-pin-sandbox.ts'
import { readSim } from './sandbox/sandbox-repository.ts'
import type { Box, SimState } from './sandbox/sandbox-types.ts'

const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
type CiReceipt = Extract<CanonicalRecord, { kind: 'action-receipt' }> & {
  payload: Extract<ActionReceiptPayload, { action: 'attribute-ci'; phase: 'result' }>
}
export type CiOperands = Extract<NonNullable<ActionInputs['manifest']['operands']>, { action: 'attribute-ci' }>
export type MatrixSetup = {
  box: Box
  intake: ActionInputs
  subject: Extract<ActionInputs['manifest']['subject'], { kind: 'uw' }> & {
    binding: RecordInputRef
    pullRequest: NonNullable<ActionInputs['manifest']['subject']['pullRequest']>
  }
  ref: RecordInputRef
  history: DecodedHistory
  op: OperationRead
  receipt: CiReceipt
  binding: Extract<CanonicalRecord, { kind: 'workflow-binding' }>
  baseline: SimState
  refused: (
    name: string,
    code: UwActionRequest['code'],
    refs: RecordInputRef[],
    expected?: string | string[],
  ) => { ok: boolean; inputs?: ActionInputs; diagnostics?: { code: string }[] }
}

export async function setupMatrix(roots: Set<string>): Promise<MatrixSetup> {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  const pin = isolatedPinSandbox(box)
  const control = path.join(box.root, 'pin-control.json')
  writeFileSync(control, JSON.stringify({ shared: pin.candidate }))
  box.env = { ...pin.env, PIN_CONTROL_FILE: control }
  await seedReviewFixture(box, cwd)
  appendApprovedReview(box, cwd)
  setFailedCi(box)
  writeFileSync(control, '{}')
  const prefix = spawnSync(
    bun,
    [path.resolve(import.meta.dirname, 'ci-attribution-provenance-prefix-runner.ts'), cwd, 'capture-intake'],
    {
      cwd,
      env: box.env,
      encoding: 'utf8',
      timeout: 55_000,
    },
  )
  expect(prefix.status, `${prefix.stderr}\n${prefix.stdout}`).toBe(0)
  // Subsequent prepare processes are independent of the captured host activation.
  writeFileSync(control, JSON.stringify({ shared: pin.candidate }))
  const captured = JSON.parse(prefix.stdout) as { intake: ActionInputs }
  const intake = captured.intake
  const subject = intake.manifest.subject
  if (subject.kind !== 'uw' || !subject.binding || !subject.pullRequest) throw new Error('bound-intake-subject-missing')
  const ref = intake.stageSources[0]
  if (!ref || intake.stageSources.length !== 1) throw new Error('attribution-ref-missing')
  const history = pullHistory(box)
  const op = history.operations.find((item) => item.recordId === ref.record.recordId)
  const receipt = op?.record
  if (
    !op ||
    receipt?.kind !== 'action-receipt' ||
    receipt.payload.phase !== 'result' ||
    receipt.payload.action !== 'attribute-ci'
  )
    throw new Error('attribution-result-missing')
  const binding = history.operations.find((item) => item.recordId === subject.binding?.record.recordId)?.record
  if (binding?.kind !== 'workflow-binding') throw new Error('workflow-binding-missing')
  expect(accounted(history, receipt)).toBe(true)
  expect(accounted(history, binding)).toBe(true)
  expect(receipt.payload.inputs.manifest.subject).toEqual(subject)
  expect(receipt.payload.mandate).toEqual(binding.payload.mandate)
  expect(ref.digest).toBe(canonicalValueDigest(receipt.payload))
  const baseline = readSim(box)
  const run = (code: UwActionRequest['code'], refs: RecordInputRef[], name = 'baseline') => {
    const before = readSim(box)
    const result = spawnSync(
      bun,
      [
        path.resolve(import.meta.dirname, 'ci-attribution-prepare-matrix-runner.ts'),
        cwd,
        JSON.stringify({ code, scope: subject.pullRequest, refs }),
      ],
      { cwd, env: box.env, encoding: 'utf8', timeout: 55_000 },
    )
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
    const after = readSim(box)
    if (name === 'baseline') {
      expect(after.prs['7']?.comments).toEqual(before.prs['7']?.comments)
      expect(after.issues['42']?.comments).toEqual(before.issues['42']?.comments)
    } else {
      expect.soft(after.prs['7']?.comments, `${name}: PR records changed`).toEqual(before.prs['7']?.comments)
      expect.soft(after.issues['42']?.comments, `${name}: UW records changed`).toEqual(before.issues['42']?.comments)
    }
    return JSON.parse(result.stdout) as { ok: boolean; inputs?: ActionInputs; diagnostics?: { code: string }[] }
  }
  const good = run(intake.manifest.code, [ref])
  expect(good.ok, JSON.stringify(good)).toBe(true)
  expect(good.inputs?.manifest.subject).toEqual(subject)
  expect(good.inputs?.stageSources).toEqual([ref])
  const refused = (
    name: string,
    code: UwActionRequest['code'],
    refs: RecordInputRef[],
    expected: string | string[] = 'self-output',
  ) => {
    const result = run(code, refs, name)
    expect.soft(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(false)
    for (const diagnostic of typeof expected === 'string' ? [expected] : expected)
      expect
        .soft(
          result.diagnostics?.map((item) => item.code),
          `${name}: ${JSON.stringify(result)}`,
        )
        .toContain(diagnostic)
    return result
  }
  return {
    box,
    intake,
    subject: { ...subject, binding: subject.binding, pullRequest: subject.pullRequest },
    ref,
    history,
    op,
    receipt: { ...receipt, payload: receipt.payload },
    binding,
    baseline,
    refused,
  }
}
