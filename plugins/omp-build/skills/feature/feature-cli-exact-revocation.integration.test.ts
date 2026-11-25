import { expect, it } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { bindExternalRef, decodeHistory, readGitHubHistory, resolveAcceptedSpec } from '../../dist/contracts.js'
import { buildRecord } from '../../engine/record-construction.ts'
import { admitFeature } from '../../omp/omp-feature-admission.ts'
import type { ContinueFeatureInput } from '../../roxabi/feature-contract.ts'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy.ts'
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
  revoke,
  seedAuthority,
  world,
} from './feature-cli.fixture.ts'

const scope = { repository, target: `${repository}#42` }
const prReference = `${repository}#${pr}`

async function revocationFixture(
  f: Required<Pick<ContinueFeatureInput, 'cwd' | 'gh'>> & { gitRunner: NonNullable<ContinueFeatureInput['git']> },
  reference = scope.target,
  transport = f.gh,
) {
  const gh: Gh = async (cwd, args) => {
    const response = fixtureCatalogueGhResponse(args) ?? (await transport(cwd, args))
    // GitHub's issues API marks PR-backed issues; the sandbox serves their metadata without the marker.
    if (reference === prReference && args[0] === 'api' && args[1] === `repos/${repository}/issues/${pr}`)
      return JSON.stringify({ ...JSON.parse(response), pull_request: {} })
    return response
  }
  const approved: string[] = []
  const uw = await createInstalledUwOperations({
    cwd: f.cwd,
    gh,
    operator: {
      async executeConfirmed(prepared, action) {
        expect(prepared.proposal).toMatchObject({ format: 'omp-build-uw-abandon/1', uw: scope })
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
  const input = { cwd: f.cwd, reference, principal: false, gh, git: f.gitRunner, uw }
  const read = async () => decodeHistory(await readGitHubHistory(scope, withRoxabiGitHubPolicy(input)))
  return { input, approved, read }
}

function frame(record: { kind: string; recordId: string; operationId: string; payload: unknown }) {
  const { kind, recordId, operationId } = record
  const id = encodeURIComponent(recordId)
  const operation = encodeURIComponent(operationId)
  const data = Buffer.from(JSON.stringify(record)).toString('base64url')
  return `<!-- omp-build-record v=1 kind=${kind} id=${id} operationId=${operation} part=1/1 data=${data} -->\n# ${kind}`
}

it.each([
  { name: 'revokes exact authority even without its Accepted Spec', unreadable: true },
  { name: 'admits an authorized successor on the same UW in process after revocation', unreadable: false },
])('$name', async ({ unreadable }) => {
  const f = world(true)
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

  const { input, approved } = await revocationFixture(f)
  const { gh, uw } = input
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

it('revokes an intact PR binding despite an incompatible historical assessment and blocks later push and land', async () => {
  const f = world(true)
  const originalDigest = acceptedDigest(f)
  const oldAssessment = frame({
    kind: 'action-receipt',
    recordId: 'old-assessment',
    operationId: 'op-old-assessment',
    payload: { action: 'assess-spec', phase: 'start', exactInputs: { format: 'omp-build-spec-assessment/2' } },
  })
  appendSimIssueComments(f.box, '42', [oldAssessment], 'operator', date)
  const { input, approved, read } = await revocationFixture(f, prReference)
  expect((await read()).diagnostics).toContainEqual(
    expect.objectContaining({ code: 'incompatible-format', operationId: 'op-old-assessment' }),
  )

  expect(await admitFeature({ ...input, control: 'abandon' })).toEqual({ kind: 'abandoned', confirmed: true })
  expect(approved).toHaveLength(1)
  const [recordId] = approved
  if (recordId === undefined) throw new Error('Expected the exact revocation')
  expect(bindExternalRef({ scope, recordId, kind: 'operator-control' }, await read())).toMatchObject({
    ok: true,
    value: { payload: { control: 'abandon', mandate: fixtures.mandateRef(f.mandate) } },
  })

  // Restore healthy read visibility without removing the revocation, so an unrelated
  // format refusal cannot mask a missing durable stop in either effect.
  writeSim(f.box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('Expected the bound issue')
    issue.comments = issue.comments.filter((comment) => comment.body !== oldAssessment)
  })
  git(f.box, f.cwd, ['commit', '-qm', 'fix: candidate correction', '--allow-empty'])
  const tip = git(f.box, f.cwd, ['rev-parse', 'HEAD'])
  const refused = { code: 1, status: 'refused', reason: 'exact-mandate-abandoned' }
  expect(await invoke(f, 'push', ['--pr', String(pr), '--from', f.tip, '--tip', tip])).toMatchObject(refused)
  expect(await invoke(f, 'land', ['--pr', String(pr), '--head', f.tip, '--spec', originalDigest])).toMatchObject(
    refused,
  )
  expect(f.bare('rev-parse', ref)).toBe(f.tip)
  expect(readSim(f.box).calls.some((args) => args[0] === 'pr' && args[1] === 'merge')).toBe(false)
})

it('revokes the PR-bound mandate without selecting another active mandate on the issue', async () => {
  const f = world(true)
  const other = fixtures.featureMandate(scope, {
    ownSpec: f.spec.ownSpec,
    recordId: 'other-active-mandate',
    operationId: 'op-other-active-mandate',
    runId: 'run00002',
    run: 'run00002',
    branch: 'feat/42-other',
    lineageHead: f.base,
  })
  seedAuthority(f.box, [f.mandate, other])
  const { input, approved, read } = await revocationFixture(f, prReference)
  expect(await admitFeature({ ...input, control: 'abandon' })).toEqual({ kind: 'abandoned', confirmed: true })
  const history = await read()
  expect(
    history.operations.flatMap((operation) => {
      const record = operation.record
      return record?.kind === 'operator-control' && record.payload.control === 'abandon' ? [record.payload.mandate] : []
    }),
  ).toEqual([fixtures.mandateRef(f.mandate)])
  expect(bindExternalRef(fixtures.mandateRef(other), history)).toMatchObject({ ok: true })
  expect(approved).toHaveLength(1)
})

it('never falls back to the current successor when the PR is still bound to an abandoned mandate', async () => {
  const f = world(true)
  revoke(f)
  const { input, approved, read } = await revocationFixture(f, prReference)
  const before = await read()

  expect(await admitFeature({ ...input, control: 'abandon' })).toMatchObject({
    kind: 'abandoned',
    confirmed: false,
    failure: { status: 'refused', diagnostics: [expect.objectContaining({ code: 'abandoned' })] },
  })
  expect(approved).toEqual([])
  expect((await read()).source.comments).toEqual(before.source.comments)
})

it.each([
  { editedKind: 'operator-control', name: 'revokes an issue mandate despite an edited material acceptance' },
  { editedKind: 'mandate', name: 'refuses issue revocation when the mandate itself was edited' },
])('$name', async ({ editedKind }) => {
  const f = world()
  const mandate = fixtures.mandateRef(f.mandate)
  const digest = 'a'.repeat(64)
  const approval = buildRecord({
    ...scope,
    version: 1,
    kind: 'operator-control',
    recordId: 'accept-material',
    operationId: 'op-accept-material',
    runId: 'run00001',
    payload: {
      control: 'accept-material',
      controlId: 'accept-material',
      mandate,
      predecessor: mandate,
      assessment: { scope, recordId: 'assessment', kind: 'action-receipt' },
      specVersion: f.spec.ownSpec.version,
      proposalDigest: digest,
      authorization: { kind: 'direct' },
      confirmation: {
        route: 'omp-native-command',
        operationId: 'op-accept-material',
        proposalDigest: digest,
        confirmedAt: date,
      },
      identityDelta: { retired: [] },
    },
  })
  if (!approval.ok) throw new Error(JSON.stringify(approval.diagnostics))
  appendSimIssueComments(f.box, '42', [frame(approval.value)], 'operator', date)
  const { input, approved, read } = await revocationFixture(f)
  const preEdit = bindExternalRef({ scope, recordId: 'accept-material', kind: 'operator-control' }, await read())
  expect(preEdit, JSON.stringify(preEdit)).toMatchObject({ ok: true })
  writeSim(f.box, (state) => {
    const edited = state.issues['42']?.comments.find((comment) =>
      comment.body.startsWith(`<!-- omp-build-record v=1 kind=${editedKind} `),
    )
    if (!edited) throw new Error(`Expected the ${editedKind} frame`)
    edited.updatedAt = '2026-01-02T00:00:00Z'
  })
  expect((await read()).operations).toContainEqual(
    expect.objectContaining({ kind: editedKind, status: 'invalid', record: null }),
  )

  const result = await admitFeature({ ...input, control: 'abandon' })
  if (editedKind === 'mandate') {
    expect(result).toMatchObject({
      kind: 'abandoned',
      confirmed: false,
      failure: { status: 'refused', diagnostics: [expect.objectContaining({ code: 'unconfirmed' })] },
    })
    expect(approved).toEqual([])
    return
  }
  expect(result).toEqual({ kind: 'abandoned', confirmed: true })
  const [recordId] = approved
  if (recordId === undefined) throw new Error('Expected the exact issue revocation')
  expect(bindExternalRef({ scope, recordId, kind: 'operator-control' }, await read())).toMatchObject({
    ok: true,
    value: { payload: { control: 'abandon', mandate } },
  })
})

it('returns partial when the native readback includes an unreadable claim to the written revocation ID', async () => {
  const f = world()
  const gh: Gh = async (cwd, args) => {
    const result = await f.gh(cwd, args)
    if (args[0] === 'api' && args[2] === 'POST' && args[3] === `repos/${repository}/issues/42/comments`) {
      const [recordId] = approved
      if (recordId === undefined) throw new Error('Expected the operator-approved record ID before write')
      appendSimIssueComments(
        f.box,
        '42',
        [frame({ kind: 'operator-control', recordId, operationId: 'op-unreadable-copy', payload: {} })],
        'operator',
        date,
      )
    }
    return result
  }
  const { input, approved, read } = await revocationFixture(f, scope.target, gh)
  expect(await admitFeature({ ...input, control: 'abandon' })).toMatchObject({
    kind: 'abandoned',
    confirmed: false,
    failure: { status: 'partial' },
  })
  const [recordId] = approved
  if (recordId === undefined) throw new Error('Expected the operator to have confirmed the proposal')
  const history = await read()
  expect(history.operations).toContainEqual(
    expect.objectContaining({ recordId, status: 'complete', record: expect.objectContaining({ recordId }) }),
  )
  expect(bindExternalRef({ scope, recordId, kind: 'operator-control' }, history)).toMatchObject({
    ok: false,
    diagnostics: [expect.objectContaining({ code: 'unconfirmed' })],
  })
})
