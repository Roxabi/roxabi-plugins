import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CauseSisterInput } from '../../engine/cause-disposition-schema.ts'
import type { ScopedRecordRef } from '../../engine/record-references.ts'
import type { NativeBatch } from '../../omp/review-runtime/contracts.ts'
import { createNativeReviewPort } from '../../omp/review-runtime/port.ts'
import { releaseTaskMask } from '../../omp/review-runtime/task-mask-lease.ts'
import { composedAssessmentJudgment, composedSisterRequest } from '../../testing/composed-sister-scenario.ts'
import { installedMultiSisterFixture } from '../../testing/multi-sister-installed-fixture.ts'
import { bridgeHarness, cleanupFixtureActions, root } from '../../testing/review-runtime-support.ts'
import { startDispatch } from '../feature-start-executions.ts'
import type { InstalledPluginPin } from '../uw-action-contract.ts'
import { createProductionActionPorts } from '../uw-input-readers.ts'
import type { UwNativeHost } from '../uw-installed-operations.ts'
import { defaultGit } from '../workflow-checkout.ts'

export const preparationTap = { onPrepared: null as null | ((operationId: string) => void) }
const directories: string[] = []
export function cleanupComposedScenario(): void {
  preparationTap.onPrepared = null
  cleanupFixtureActions()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
}
type FixtureIssue = {
  title: string
  body: string
  labels: string[]
  parent: number | null
  blockers: number[]
  state: 'OPEN' | 'CLOSED'
}
export type MutationWorld = {
  issues: Map<number, FixtureIssue>
  comments: Map<number, { id: number; body: string; user: { login: string }; created_at: string; updated_at: string }[]>
}
// Native execution is SDK-shaped fixture capture over declared GitHub facts, not a human or hosted run.
export async function scenario(
  confirm: (world: MutationWorld) => boolean,
  afterParentRelation?: (world: MutationWorld) => void,
  preflightRequest?: (request: CauseSisterInput) => CauseSisterInput,
  onPrepared?: (world: MutationWorld, operationId: string) => void,
  mode?: 'stop-assessment',
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
  let assessmentStart: ScopedRecordRef | null = null
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
    onStarted(event) {
      if (batch === null) throw new Error('Assessment start has no batch')
      assessmentStart = event.assessmentStart
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
  preparationTap.onPrepared = onPrepared ? (operationId) => onPrepared(world, operationId) : null
  const outcome = world.operations.createSister(request)
  const opened = await Promise.race([
    started.promise.then((value) => ({ kind: 'started' as const, value })),
    outcome.then((value) => ({ kind: 'finished' as const, value })),
  ])
  if (opened.kind !== 'started') {
    if (preflightRequest !== undefined) return { world, request, decisions, result: opened.value }
    throw new Error(`Assessment did not start: ${JSON.stringify(opened.value)}`)
  }
  if (mode === 'stop-assessment') {
    if (assessmentStart === null) throw new Error('Assessment START unavailable')
    await harness.controller.stopOwned(opened.value, 'assessment-test-stop')
    return { world, request, decisions, result: await outcome, assessmentStop: startDispatch(assessmentStart) }
  }
  if (decisions.length !== 0 || world.issues.has(43))
    throw new Error('Confirmation or sister creation occurred before the assessment')
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
