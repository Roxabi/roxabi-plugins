import { execFileSync } from 'node:child_process'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { MandateRecord, ReceiptRecord } from '../engine/workflow-control.ts'
import { SCOPE } from './feature-recovery-fixture.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { readSim, writeSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

const fixtures = roxabiWorkflowFixtures()
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

export function post(box: Box, posted: readonly CanonicalRecord[]): void {
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('missing feature issue')
    issue.comments = fixtures.framedBodies(posted, 'operator').map((body) => ({ author: 'operator', body }))
  })
}

export function sandboxMandate(box: Box): MandateRecord {
  const original = records(box).find((record) => record.kind === 'mandate')
  if (original?.kind !== 'mandate') throw new Error('missing feature mandate')
  return original
}

export function pauseRecords(mandate: MandateRecord): CanonicalRecord[] {
  const request = fixtures.pauseRequested(mandate)
  return [request, fixtures.pauseConfirmed(mandate, request)]
}

/** Read old records through the installed UW adapter, using the fixture's Gh transport. */
export function readHistoricalResolution(world: World): unknown {
  const port = new URL('../roxabi/uw-read-port.ts', import.meta.url).pathname
  const contracts = new URL('../dist/contracts.js', import.meta.url).pathname
  const scope = { repository: world.start.repository, target: world.start.target }
  const program = `
    import { createInstalledUwReadPort } from ${JSON.stringify(port)}
    import { selectApplicableMandate, startResolution } from ${JSON.stringify(contracts)}
    const uw = ${JSON.stringify(SCOPE)}
    const start = ${JSON.stringify({ scope, kind: 'action-receipt', recordId: world.start.recordId })}
    const { observation } = await createInstalledUwReadPort({ cwd: process.cwd() }).readUw(uw)
    if (observation.status !== 'complete') throw Error(JSON.stringify(observation))
    const home = observation.histories.find(history => history.source.scope.target === uw.target)
    if (!home) throw Error('issue history missing')
    const selection = selectApplicableMandate(
      home, observation.histories.filter(history => history !== home),
      { histories: observation.histories, catalogues: observation.catalogues, observation }
    )
    console.log(JSON.stringify({ selection, resolution: startResolution(observation.histories, start) }))
  `
  return JSON.parse(
    execFileSync('bun', ['--eval', program], {
      cwd: world.box.principal,
      env: world.box.env,
      encoding: 'utf8',
    }),
  )
}
