import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { bindExternalRef, recordsOf } from '../../dist/contracts.js'
import type { CauseSisterInput } from '../../engine/cause-disposition-schema.ts'
import type { NativeBatch } from '../../omp/review-runtime/contracts.ts'
import { createNativeReviewPort } from '../../omp/review-runtime/port.ts'
import { releaseTaskMask } from '../../omp/review-runtime/task-mask-lease.ts'
import { composedAssessmentJudgment, composedSisterRequest } from '../../testing/composed-sister-scenario.ts'
import { installedMultiSisterFixture } from '../../testing/multi-sister-installed-fixture.ts'
import { bridgeHarness, cleanupFixtureActions, root } from '../../testing/review-runtime-support.ts'
import type { InstalledPluginPin } from '../uw-action-contract.ts'
import { createProductionActionPorts } from '../uw-input-readers.ts'
import type { UwNativeHost } from '../uw-installed-operations.ts'
import { defaultGit } from '../workflow-checkout.ts'

type FixtureIssue = {
  title: string
  body: string
  labels: string[]
  parent: number | null
  blockers: number[]
  state: 'OPEN' | 'CLOSED'
}
type MutationWorld = {
  issues: Map<number, FixtureIssue>
  comments: Map<number, { id: number; body: string; user: { login: string }; created_at: string; updated_at: string }[]>
}
const directories: string[] = []
afterEach(() => {
  cleanupFixtureActions()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

// Native execution is SDK-shaped fixture capture over declared GitHub facts, not a human or hosted run.
async function scenario(
  confirm: (world: MutationWorld) => boolean,
  afterParentRelation?: (world: MutationWorld) => void,
  preflightRequest?: (request: CauseSisterInput) => CauseSisterInput,
) {
  const directory = mkdtempSync(join(tmpdir(), 'omp-composed-sister-'))
  directories.push(directory)
  const checkout = join(directory, 'checkout')
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', checkout)
  writeFileSync(join(checkout, 'README.md'), 'Declared parent checkout\n')
  git('-C', checkout, 'add', 'README.md')
  git(
    '-C',
    checkout,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'Declared parent checkout',
  )
  const commit = git('-C', checkout, 'rev-parse', 'HEAD')
  const tree = git('-C', checkout, 'rev-parse', 'HEAD^{tree}')
  const harness = bridgeHarness()
  const context = {
    ...root,
    cwd: checkout,
    hasUI: true,
    mode: 'tui',
    localProtocolOptions: { getArtifactsDir: () => directory },
  }
  await harness.emitBridge('session_start', { type: 'session_start' }, context)
  harness.controller.bindHostGit(() => ({ repository: 'acme/app', commit, tree }))
  const nativePort = createNativeReviewPort(harness.native, harness.controller)
  const started = Promise.withResolvers<NativeBatch>()
  const abort = new AbortController()
  const runner = defaultGit()
  let batch: NativeBatch | null = null
  let pin: InstalledPluginPin | null = null
  const pluginRoot = fileURLToPath(new URL('../../', import.meta.url))
  const bytes = (path: string) => new Uint8Array(readFileSync(join(pluginRoot, path)))
  const host: UwNativeHost = {
    native: {
      active: harness.controller.active.bind(harness.controller),
      activate: nativePort.activate,
      stopOwned: nativePort.stopOwned,
      announce: nativePort.announce,
    },
    signal: abort.signal,
    actionReaders: {
      git: runner,
      createPorts(options) {
        const production = createProductionActionPorts(options)
        if (pin === null) throw new Error('Fixture plugin pin unavailable')
        const declared = pin
        const pinnedBytes = (path: string) => {
          const prefix = `${declared.root}/`
          if (!path.startsWith(prefix)) throw new Error(`Undeclared pinned path ${path}`)
          return bytes(path.slice(prefix.length))
        }
        return {
          ...production,
          plugin: {
            async resolveInstalledPluginPin() {
              return { ok: true, value: declared }
            },
            async readInstalledFile(path) {
              return { ok: true, value: bytes(path) }
            },
          },
          async readPinnedFile(ref) {
            return { ok: true, value: pinnedBytes(ref.path) }
          },
          async readPinnedFiles(refs) {
            return { ok: true, value: refs.map((ref) => pinnedBytes(ref.path)) }
          },
          async readCodeDiff(code) {
            if (code.base !== commit || code.head !== commit) throw new Error('Undeclared code range')
            return { ok: true, value: new Uint8Array() }
          },
          async repositoryReferences() {
            return { ok: true, value: [] }
          },
        }
      },
    },
    onBatch(value) {
      if (batch !== null || harness.controller.active() !== value) throw new Error('Unexpected native batch')
      batch = value
    },
    afterSettlement(value) {
      if (batch !== value) throw new Error('Unexpected settlement')
      return harness.controller.settlementFor(value).then(async () => {
        await releaseTaskMask(harness.controller, false, value)
        if (abort.signal.aborted || harness.controller.active() !== null || harness.controller.rootContext() === null)
          throw new Error('Native continuation lost ownership')
      })
    },
    onStarted() {
      if (batch === null) throw new Error('Assessment start has no batch')
      started.resolve(batch)
    },
  }
  const decisions: { title: string; detail: string }[] = []
  const world = await installedMultiSisterFixture(1, {
    composedParent: true,
    cwd: checkout,
    artifactsDir: directory,
    nativeHost: host,
    confirm: async (title, detail): Promise<boolean> => {
      decisions.push({ title, detail })
      return confirm(world)
    },
    afterParentRelation: () => afterParentRelation?.(world),
  })
  const { files: _files, ...declaredPin } = world.graph.inputs.manifest.plugin
  pin = declaredPin
  const validRequest = composedSisterRequest(world)
  const request = preflightRequest === undefined ? validRequest : preflightRequest(validRequest)
  const outcome = world.operations.createSister(request)
  const opened = await Promise.race([
    started.promise.then((value) => ({ kind: 'started' as const, value })),
    outcome.then((value) => ({ kind: 'finished' as const, value })),
  ])
  if (opened.kind !== 'started') {
    if (preflightRequest !== undefined) return { world, request, decisions, result: opened.value }
    throw new Error(`Assessment did not start: ${JSON.stringify(opened.value)}`)
  }
  expect(decisions).toEqual([])
  expect(world.issues.has(43)).toBe(false)
  const task = opened.value.tasks.tasks[0]
  if (!task || opened.value.tasks.tasks.length !== 1) throw new Error('Expected one assessment task')
  const data = composedAssessmentJudgment(task)
  await harness.admitChild(opened.value, task.name, 'composed-assessment', {
    toolCallId: 'composed-call',
    root: context,
  })
  await harness.yieldChild('composed-assessment', data)
  await harness.settleBatch({
    toolCallId: 'composed-call',
    errors: [],
    results: [
      {
        index: 0,
        id: 'composed-assessment',
        agent: task.agent,
        exitCode: 0,
        structuredOutput: { status: 'valid', data },
      },
    ],
  })
  return { world, request, decisions, result: await outcome }
}

it('accepts a blocking sister and exact parent coverage in one confirmed decision without completing the work', async () => {
  const { world, request, decisions, result } = await scenario(() => true)
  expect(result.status, JSON.stringify(result)).toBe('created')
  if (result.status !== 'created' || world.parent === null) throw new Error('Expected created sister and active parent')
  expect(world.effective.versionVector).toEqual([
    {
      uw: request.disposition.scope,
      version: world.mandate.payload.ownSpec.version,
      sourceAccepted: { scope: request.disposition.scope, recordId: world.mandate.recordId, kind: 'mandate' },
    },
    {
      uw: world.parent.scope,
      version: world.parent.version,
      sourceAccepted: { scope: world.parent.scope, recordId: world.parent.mandate.recordId, kind: 'mandate' },
    },
  ])
  expect(decisions).toHaveLength(1)
  expect(decisions[0]?.title).toBe('Confirm UW proposal')
  expect(decisions[0]?.detail).toContain('framing: ')
  expect(decisions[0]?.detail).toContain('parent acceptance: ')
  expect(decisions[0]?.detail).toContain(world.parent.version)
  expect(world.issues.get(43)?.parent).toBe(41)
  expect(world.issues.get(42)?.blockers).toContain(43)
  const parent = await world.operations.readUw(world.parent.scope)
  expect(parent.accepted.status).toBe('accepted')
  if (parent.accepted.status !== 'accepted') throw new Error('Parent acceptance unavailable')
  expect(parent.accepted.value.ref.sourceAccepted).toEqual({
    scope: world.parent.scope,
    recordId: world.parent.mandate.recordId,
    kind: 'mandate',
  })
  const acceptance = parent.accepted.value.chain.at(-1)
  if (acceptance?.kind !== 'accept-material') throw new Error('Parent material acceptance missing')
  expect(acceptance.source).toMatchObject({ scope: world.parent.scope, kind: 'operator-control' })
  expect(parent.accepted.value.children.map((child) => child.scope)).toEqual(
    expect.arrayContaining([request.disposition.scope, result.value.uw]),
  )
  expect(
    parent.accepted.value.children.find((child) => child.scope.target === request.disposition.scope.target),
  ).toEqual(world.parent.mandate.payload.children[0])
  if (result.value.parsed.status !== 'conformant') throw new Error('Created sister Spec is not conformant')
  const createdCommitment = parent.accepted.value.children.find(
    (child) => child.scope.target === result.value.uw.target,
  )
  expect(createdCommitment).toMatchObject({
    scope: result.value.uw,
    snapshot: result.value.parsed.snapshot,
    specVersion: result.value.parsed.snapshot.spec.version,
  })
  expect(parent.accepted.value.tier).toBe(world.parent.mandate.payload.tier)
  expect(parent.accepted.value.ref.version).toBe(world.parent.version)
  expect(parent.accepted.value.coverage?.assignments[0]?.children).toEqual(
    expect.arrayContaining([request.disposition.scope, result.value.uw]),
  )
  const origin = await world.operations.readUw(request.disposition.scope)
  const own = origin.histories.find((history) => history.source.scope.target === request.disposition.scope.target)
  if (!own) throw new Error('Origin history unavailable')
  const receipt = bindExternalRef(result.receipt, own)
  if (!receipt.ok || receipt.value.kind !== 'debt-receipt') throw new Error('Authenticated debt receipt unavailable')
  expect(receipt.value.payload).toMatchObject({
    disposition: request.disposition,
    original: request.disposition.scope,
    sister: result.value.uw,
    parent: world.parent.scope,
    relation: 'original-blocked-by-sister',
  })
  const intent = bindExternalRef(receipt.value.payload.operation, own)
  if (!intent.ok || intent.value.kind !== 'cause-operation') throw new Error('Authenticated cause intent unavailable')
  const proposal = intent.value.payload.proposal
  if (proposal.operation !== 'create') throw new Error('Expected creation intent')
  const assertDisplayedConsent = () => {
    const displayed = decisions[0]?.detail.split('\n') ?? []
    const framing = displayed.find((line) => line.startsWith('framing: '))
    const acceptanceLine = displayed.find((line) => line.startsWith('parent acceptance: '))
    if (!framing || !acceptanceLine) throw new Error('Composed proposal was not displayed')
    expect(JSON.parse(framing.slice('framing: '.length))).toEqual(proposal.draft)
    expect(JSON.parse(acceptanceLine.slice('parent acceptance: '.length))).toEqual(proposal.parentAcceptance)
    expect(proposal.parentAcceptance?.exactInputs.proposed.coverage).toBeDefined()
  }
  const assertConfirmedAssessment = () => {
    assertDisplayedConsent()
    const consent = proposal.parentAcceptance
    if (consent === null) throw new Error('Composed parent consent unavailable')
    const parentHistory = parent.histories.find((history) => history.source.scope.target === world.parent?.scope.target)
    if (!parentHistory) throw new Error('Parent history unavailable')
    const control = bindExternalRef(acceptance.source, parentHistory)
    if (!control.ok || control.value.kind !== 'operator-control')
      throw new Error('Authenticated parent acceptance control unavailable')
    expect(acceptance.assessment).toEqual(consent.assessment)
    const assessment = bindExternalRef(consent.assessment, parentHistory)
    if (
      !assessment.ok ||
      assessment.value.kind !== 'action-receipt' ||
      assessment.value.payload.action !== 'assess-spec' ||
      assessment.value.payload.phase !== 'result'
    )
      throw new Error('Authenticated assessment result unavailable')
    expect(assessment.value.payload.admission).toBeNull()
    if (!assessment.value.payload.structured || !('classification' in assessment.value.payload.structured))
      throw new Error('Assessment did not produce a classification')
    expect(assessment.value.payload.structured.classification).toBe('material')
    expect(assessment.value.payload.exactInputs).toEqual(consent.exactInputs)
    const start = bindExternalRef(assessment.value.payload.start, parentHistory)
    expect(start.ok).toBe(true)
  }
  assertConfirmedAssessment()
  expect(intent.value.payload.confirmation.proposalDigest).toBe(intent.value.payload.proposalDigest)
  expect(receipt.ok).toBe(true)
  expect(recordsOf(own).filter((record) => record.kind === 'debt-receipt')).toHaveLength(1)
  expect(origin.admission.deliverable.ok).toBe(false)
  expect(origin.completion.waits.causeWaits).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ state: 'required', receipt: result.receipt, target: result.value.uw }),
    ]),
  )
  expect(
    origin.completion.completions.get(`${request.disposition.scope.repository}\0${request.disposition.scope.target}`),
  ).toMatchObject({
    state: expect.not.stringMatching(/^complete$/),
  })
  expect(
    parent.completion.completions.get(`${world.parent.scope.repository}\0${world.parent.scope.target}`),
  ).toMatchObject({
    state: expect.not.stringMatching(/^complete$/),
  })
})

it('declining the composed decision creates no sister or parent acceptance', async () => {
  const { world, decisions, result } = await scenario(() => false)
  expect(result.status).toBe('partial')
  expect(decisions).toHaveLength(1)
  expect(world.issues.has(43)).toBe(false)
  if (world.parent === null) throw new Error('Expected active parent')
  const parent = await world.operations.readUw(world.parent.scope)
  expect(parent.accepted.status).toBe('accepted')
  if (parent.accepted.status !== 'accepted') throw new Error('Parent acceptance unavailable')
  expect(parent.accepted.value.ref.sourceAccepted).toEqual({
    scope: world.parent.scope,
    recordId: world.parent.mandate.recordId,
    kind: 'mandate',
  })
})

it.each(['origin-spec', 'source-history', 'parent-vector', 'child-tier', 'parent-graph'] as const)(
  'refuses a changed %s after assessment and confirmation before sister creation',
  async (change) => {
    const { world, result, decisions, request } = await scenario((current) => {
      const origin = current.issues.get(42)
      if (!origin) throw new Error('Origin missing')
      switch (change) {
        case 'origin-spec':
          origin.body += '\nUnconfirmed material edit'
          break
        case 'source-history': {
          const source = current.comments.get(44)?.[0]
          if (!source) throw new Error('Source history missing')
          source.body += '\nUnconfirmed source edit'
          break
        }
        case 'parent-vector': {
          const parent = current.issues.get(41)
          if (!parent) throw new Error('Parent missing')
          parent.body += '\nUnconfirmed parent Spec edit'
          break
        }
        case 'child-tier':
          origin.labels = ['size:F-lite']
          break
        case 'parent-graph':
          current.issues.set(45, {
            title: 'Unconfirmed child',
            body: '',
            labels: [],
            parent: 41,
            blockers: [],
            state: 'OPEN',
          })
      }
      return true
    })
    expect(decisions).toHaveLength(1)
    expect(result.status).toBe('partial')
    expect(world.issues.has(43)).toBe(false)
    const origin = await world.operations.readUw(request.disposition.scope)
    expect(origin.admission.deliverable.ok).toBe(false)
  },
)

it('holds the origin when the created sister parent readback no longer matches', async () => {
  const { world, request, result } = await scenario(
    () => true,
    (current) => {
      const sister = current.issues.get(43)
      if (!sister) throw new Error('Created sister missing')
      sister.parent = null
    },
  )
  expect(result.status).toBe('partial')
  expect(world.issues.has(43)).toBe(true)
  const origin = await world.operations.readUw(request.disposition.scope)
  const own = origin.histories.find((history) => history.source.scope.target === request.disposition.scope.target)
  if (!own) throw new Error('Origin history unavailable')
  expect(recordsOf(own).filter((record) => record.kind === 'debt-receipt')).toEqual([])
  expect(origin.admission.deliverable.ok).toBe(false)
})

it.each(['scope', 'version'] as const)(
  'refuses parent coverage with a different %s without creation or parent acceptance',
  async (changed) => {
    const { world, decisions, result } = await scenario(
      () => true,
      undefined,
      (request) => {
        if (request.parentCoverage == null) throw new Error('Expected explicit coverage')
        const parent = request.parentCoverage.parent
        return {
          ...request,
          parentCoverage: {
            ...request.parentCoverage,
            parent:
              changed === 'scope'
                ? { ...parent, uw: { repository: parent.uw.repository, target: 'acme/app#99' } }
                : { ...parent, version: parent.version === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64) },
          },
        }
      },
    )
    expect(result.status).toBe('refused')
    expect(decisions).toEqual([])
    expect(world.issues.has(43)).toBe(false)
    if (world.parent === null) throw new Error('Expected active parent')
    const parent = await world.operations.readUw(world.parent.scope)
    expect(parent.accepted.status).toBe('accepted')
    if (parent.accepted.status !== 'accepted') throw new Error('Parent acceptance unavailable')
    expect(parent.accepted.value.ref.sourceAccepted).toEqual({
      scope: world.parent.scope,
      recordId: world.parent.mandate.recordId,
      kind: 'mandate',
    })
    const history = parent.histories.find((entry) => entry.source.scope.target === world.parent?.scope.target)
    if (!history) throw new Error('Parent history unavailable')
    expect(recordsOf(history).filter((record) => record.kind === 'operator-control')).toEqual([])
  },
)
