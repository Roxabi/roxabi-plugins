import { expect, it } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { bindExternalRef, resolveAcceptedSpec } from '../../dist/contracts.js'
import { buildRecord } from '../../engine/record-construction.ts'
import { admitFeature } from '../../omp/omp-feature-admission.ts'
import { createInstalledUwOperations } from '../../roxabi/uw-installed-operations.ts'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { appendSimIssueComments, git, readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import {
  acceptedDigest,
  branch,
  date,
  fixtures,
  invoke,
  pr,
  ref,
  repository,
  seedAuthority,
  world,
} from './feature-cli.fixture.ts'

it.each([
  { name: 'revokes exact authority even without its Accepted Spec', unreadable: true },
  { name: 'admits an authorized successor on the same UW in process after revocation', unreadable: false },
])('$name', async ({ unreadable }) => {
  const f = world(true)
  const scope = { repository, target: `${repository}#42` }
  const originalDigest = acceptedDigest(f)
  const [identity] = f.spec.ownSpec.identityAllocations
  if (identity === undefined) throw new Error('Expected a confirmed Spec identity in the fixture')
  // The second fixture keeps a conformant historical Spec so the unchanged identity ledger remains valid.
  const held = unreadable
    ? fixtures.featureMandate(scope, {
        ownSpec: f.spec.ownSpec,
        branch,
        lineageHead: f.base,
        inheritedOwnSpecRefs: [{ uw: scope, version: '0'.repeat(64), sourceAccepted: identity }],
      })
    : f.mandate
  const exact = { scope, recordId: held.recordId, kind: 'mandate' as const }
  seedAuthority(f.box, [held])

  const gh: Gh = async (cwd, args) => fixtureCatalogueGhResponse(args) ?? f.gh(cwd, args)
  const approved: string[] = []
  const uw = await createInstalledUwOperations({
    cwd: f.cwd,
    gh,
    operator: {
      async executeConfirmed(prepared, action) {
        expect(prepared.proposal).toMatchObject({ format: 'omp-build-uw-abandon/1', uw: scope, mandate: exact })
        if (!('operationId' in prepared.proposal) || typeof prepared.proposal.operationId !== 'string')
          throw new Error('Expected the abandonment operation ID')
        const operationId = prepared.proposal.operationId
        approved.push(operationId)
        return {
          status: 'confirmed',
          value: await action({
            route: 'omp-native-command',
            operationId,
            proposalDigest: prepared.digest,
            confirmedAt: date,
          }),
        }
      },
    },
  })
  const input = { cwd: f.cwd, reference: scope.target, principal: false, gh, git: f.gitRunner, uw }
  const before = await uw.readUw(scope)
  expect(before.observation.status).toBe('complete')
  const beforeHome = before.histories.find((entry) => entry.source.scope.target === scope.target)
  if (beforeHome === undefined) throw new Error('Expected the native UW history')
  expect(bindExternalRef(exact, beforeHome)).toMatchObject({ ok: true, value: held })
  expect(resolveAcceptedSpec(held, before.histories)).toMatchObject({ ok: !unreadable })

  const abandonment = await admitFeature({ ...input, control: 'abandon' })
  expect(abandonment, JSON.stringify(abandonment)).toEqual({ kind: 'abandoned', confirmed: true })
  expect(approved).toHaveLength(1)
  const [revocationId] = approved
  if (revocationId === undefined) throw new Error('Expected the operator to confirm abandonment')
  const after = await uw.readUw(scope)
  expect(after.observation.status).toBe('complete')
  const afterHome = after.histories.find((entry) => entry.source.scope.target === scope.target)
  if (afterHome === undefined) throw new Error('Expected the native UW history after abandonment')
  const revocation = bindExternalRef({ scope, recordId: revocationId, kind: 'operator-control' }, afterHome)
  expect(revocation).toMatchObject({
    ok: true,
    value: { kind: 'operator-control', payload: { control: 'abandon', mandate: exact, predecessor: null } },
  })
  if (!revocation.ok) throw new Error('Expected an authenticated abandonment record')

  git(f.box, f.cwd, ['commit', '-qm', 'fix: candidate correction', '--allow-empty'])
  const tip = git(f.box, f.cwd, ['rev-parse', 'HEAD'])
  const refused = { code: 1, status: 'refused', reason: 'exact-mandate-abandoned' }
  const oldAuthority = { gh, mandate: held.recordId }
  expect(await invoke(f, 'push', ['--pr', String(pr), '--from', f.tip, '--tip', tip], oldAuthority)).toMatchObject(
    refused,
  )
  expect(
    await invoke(f, 'land', ['--pr', String(pr), '--head', f.tip, '--spec', originalDigest], oldAuthority),
  ).toMatchObject(refused)
  expect(f.bare('rev-parse', ref)).toBe(f.tip)
  const remote = readSim(f.box)
  expect(remote.prs[String(pr)]?.state).toBe('OPEN')
  expect(remote.calls.some((args) => args[0] === 'pr' && args[1] === 'merge')).toBe(false)
  if (unreadable) return

  const successor = fixtures.featureMandate(scope, {
    ownSpec: f.spec.ownSpec,
    recordId: 'mandate-next',
    operationId: 'op-mandate-next',
    runId: 'run00002',
    run: 'run00002',
    antecedent: exact,
    branch,
    lineageHead: f.base,
  })
  const selection = buildRecord({
    ...scope,
    version: 1,
    recordId: 'select-next-mandate',
    operationId: 'op-select-next-mandate',
    runId: successor.runId,
    kind: 'operator-control',
    payload: {
      control: 'select-successor',
      controlId: 'select-next-mandate',
      mandate: exact,
      predecessor: exact,
      successor: fixtures.mandateRef(successor),
    },
  })
  if (!selection.ok) throw new Error(JSON.stringify(selection.diagnostics))
  const existing = [held, revocation.value]
  const authorized = [...existing, successor, selection.value]
  const newBodies = fixtures
    .framedBodies(authorized, 'operator')
    .slice(fixtures.framedBodies(existing, 'operator').length)
  appendSimIssueComments(f.box, '42', newBodies, 'operator', '2026-01-02T00:00:00Z')
  const binding = fixtures.workflowBinding({ repository, target: `${repository}#${pr}` }, successor, branch, 'main')
  const bodies = fixtures.framedBodies([binding], 'operator', [fixtures.historyFrom(authorized)])
  writeSim(f.box, (state) => {
    const pull = state.prs[String(pr)]
    if (!pull) throw new Error('Expected the bound pull request')
    pull.comments.push(
      ...bodies.map((body, index) => ({ id: 200 + index, author: 'operator', body, createdAt: date, updatedAt: date })),
    )
  })
  const ready = await admitFeature({ ...input, control: 'continue' })
  expect(ready, JSON.stringify(ready)).toMatchObject({
    kind: 'ready',
    mandate: successor.recordId,
    branch,
    base: 'main',
  })
  expect(approved).toHaveLength(1)
})
