import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { parseRecord } from '../engine/record-construction.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { MandateRecord, ReceiptRecord } from '../engine/workflow-control.ts'
import type { ResolutionProposal } from '../engine/workflow-interruption-proof.ts'
import { coldCheckout } from '../roxabi/feature-recovery-process-fixture.ts'
import { configPinDigest, effectiveWorkflowConfig } from '../roxabi/workflow-config-digest.ts'
import { SCOPE } from './feature-recovery-fixture.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { readSim, writeSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

const RUNNER = path.resolve(import.meta.dirname, './feature-interruption-runner.ts')
const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const fixtures = roxabiWorkflowFixtures()
export type Prompt = { proposal: Record<string, unknown>; digest: string }
export type Outcome = { result: Record<string, unknown>; prompts: Prompt[]; observed: Array<Record<string, unknown>> }
type RunPayload = {
  start: string | null
  executor: 'settled' | 'busy' | 'unobserved' | 'missing' | 'known-unretained-terminal'
  operator: 'confirm' | 'defer' | 'stale-commit' | 'stale-comment' | 'throw-before' | 'throw-after' | 'abandon-readback'
  inject: string | null
  startTarget: string | null
  mandateId: string | null
}
export type World = { box: Box; mandate: MandateRecord; start: ReceiptRecord }

function history(box: Box) {
  return decodeHistory({
    scope: SCOPE,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: (readSim(box).issues['42']?.comments ?? []).map((comment, index) => ({
      locator: `acme/app#42:comment:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
    diagnostics: [],
  })
}

export function records(box: Box): CanonicalRecord[] {
  return history(box).operations.flatMap((operation) => {
    if (!operation.record) throw new Error('invalid fixture history')
    return [operation.record]
  })
}

export function resolutions(box: Box): CanonicalRecord[] {
  return records(box).filter(
    (record) => record.kind === 'operator-control' && record.payload.control === 'resolve-interruption',
  )
}

export function controls(box: Box): string[] {
  return records(box).flatMap((record) => (record.kind === 'operator-control' ? [record.payload.control] : []))
}

export function post(box: Box, posted: readonly CanonicalRecord[]): void {
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('missing feature issue')
    issue.comments = fixtures.framedBodies(posted, 'operator').map((body) => ({ author: 'operator', body }))
  })
}

/** The accepted mandate of the sandbox, optionally pinned to a drifted product version. */
export function sandboxMandate(box: Box, productVersion?: string): MandateRecord {
  const original = records(box).find((record) => record.kind === 'mandate')
  if (original?.kind !== 'mandate') throw new Error('missing feature mandate')
  if (productVersion === undefined) return original
  const effective = effectiveWorkflowConfig(productVersion, [])
  const parsed = parseRecord({
    ...original,
    payload: {
      ...original.payload,
      config: { ...original.payload.config, productVersion, effective, digest: configPinDigest(effective) },
    },
  })
  if (!parsed.ok || parsed.value.kind !== 'mandate') throw new Error('invalid drifted mandate fixture')
  return parsed.value
}

export function pauseRecords(mandate: MandateRecord): CanonicalRecord[] {
  const request = fixtures.pauseRequested(mandate)
  return [request, fixtures.pauseConfirmed(mandate, request)]
}
export function resolve(world: World, name: string, payload: Partial<RunPayload> = {}, checkout?: string): Outcome {
  const cwd = checkout ?? coldCheckout(world.box, name)
  const home = path.join(world.box.root, `home-${name}`)
  mkdirSync(home, { recursive: true })
  const run = spawnSync(
    BUN,
    [
      RUNNER,
      cwd,
      JSON.stringify({
        reference: '#42',
        start: world.start.recordId,
        executor: 'settled',
        operator: 'confirm',
        inject: null,
        ...payload,
      }),
    ],
    { cwd, env: { ...world.box.env, HOME: home }, encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`resolve-interruption failed: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as Outcome
}

export function proposalOf(record: CanonicalRecord): ResolutionProposal {
  if (record.kind !== 'operator-control' || record.payload.control !== 'resolve-interruption')
    throw new Error('expected a resolution record')
  const { proposalDigest: _digest, confirmation: _confirmation, ...proposal } = record.payload
  return proposal as ResolutionProposal
}

export function runtimeOf(mandate: MandateRecord) {
  return {
    productVersion: mandate.payload.config.productVersion,
    configVersion: mandate.payload.config.version,
    configDigest: mandate.payload.config.digest,
  }
}
