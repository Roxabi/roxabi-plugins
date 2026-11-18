/**
 * Fresh-process adapter host for outside-effect succession.
 * Installs fixture SDK settings before any workflow/material import — same seam as feature-recovery-runner.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import type { ContinueFeatureResult, FeatureWorkflow } from '../roxabi/feature-contract.ts'
import type { OutsideEffectProduceFacts, OutsideEffectWorkerMode } from './context-external-effect-fixture.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

const [cwd, stateFile, outsidePath, modeArg, produceFactsPath] = process.argv.slice(2)
if (!cwd || !stateFile || !outsidePath || !modeArg || !produceFactsPath)
  throw new Error('outside-effect-runtime-arguments-missing')
if (modeArg !== 'attributed-success' && modeArg !== 'recreate-preselection')
  throw new Error(`outside-effect-runtime-mode-invalid:${modeArg}`)
const mode: OutsideEffectWorkerMode = modeArg

await installFixtureSdkSettings(cwd)

const { createFixtureContextEffectObserverFactory, fixtureScopeFromReference } = await import(
  './context-effect-review-fixture.ts'
)
const {
  changeOutsideEffectSpecBody,
  confirmedOutsideEffectOperator,
  createRecreateBeforeSelectionObserverFactory,
  inventorySuccessorPublication,
  prepareOutsideEffectIntent,
} = await import('./context-external-effect-fixture.ts')
const { acceptContextMaterial } = await import('./feature-context-material-driver.ts')
const { finishContextPlan } = await import('./feature-context-plan-driver.ts')
const { loadFeatureWorkflow } = await import('../roxabi/feature-loader.ts')
const { createInstalledUwOperations } = await import('../roxabi/uw-installed-operations.ts')
const { decodeHistory } = await import('../adapters/github/history-codec.ts')
type SimState = import('./sandbox/sandbox-types.ts').SimState

const produce = JSON.parse(readFileSync(produceFactsPath, 'utf8')) as OutsideEffectProduceFacts

type PreparedIntent = Awaited<ReturnType<typeof prepareOutsideEffectIntent>>
type DecodeIssue = () => ReturnType<typeof decodeHistory>
type CreateUw = () => Promise<Awaited<ReturnType<typeof createInstalledUwOperations>>>

function loadOutsideEffectWorkflow(): {
  createUw: CreateUw
  decodeIssue: DecodeIssue
} {
  const createUw: CreateUw = () => createInstalledUwOperations({ cwd, operator: confirmedOutsideEffectOperator })
  const issueComments = () => {
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as SimState
    return state.issues['42']?.comments ?? []
  }
  const decodeIssue: DecodeIssue = () =>
    decodeHistory({
      scope: fixtureScopeFromReference('#42'),
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      diagnostics: [],
      comments: issueComments().map((comment, index) => ({
        locator: `acme/app#42:${index + 1}`,
        nativeId: String(index + 1),
        body: comment.body,
        author: comment.author,
        createdAt: comment.createdAt ?? null,
        updatedAt: comment.updatedAt ?? null,
      })),
    })
  return { createUw, decodeIssue }
}

function locateConservedOutsideEffectNegative(decodeIssue: DecodeIssue) {
  const history = decodeIssue()
  const negative = history.operations.find(
    (operation) =>
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.action === 'implement' &&
      operation.record.payload.phase === 'result',
  )?.record
  if (negative?.kind !== 'action-receipt') throw new Error('outside-effect-negative-missing-from-history')
  return {
    negativeRecordId: negative.recordId,
    retainedNegative: JSON.stringify(negative),
  }
}

/** Pre-succession ordinary/cold holds and preparation of the unresolved intent. */
async function runNegativeHoldChecks(input: {
  workflow: FeatureWorkflow
  createUw: CreateUw
  negativeRecordId: string
}) {
  const { workflow, createUw, negativeRecordId } = input
  const continueWithoutHandoff = await workflow.continueFeature({
    cwd,
    reference: '#42',
    control: 'continue',
    principal: false,
    uw: await createUw(),
  })
  const unresolvedPrepared = await prepareOutsideEffectIntent({
    cwd,
    negativeRecordId,
    absoluteOutsidePath: outsidePath,
    unresolved: true,
  })
  // Pre-succession cold continue: no select-successor disposition yet, so this must not
  // invent a managed-baseline waiver or re-sample historical named-file effectReview.
  const coldContinue = await workflow.continueFeature({
    cwd,
    reference: '#42',
    control: 'continue',
    principal: false,
    uw: await createUw(),
  })
  return {
    continueWithoutHandoff,
    unresolvedPrepared,
    coldContinue,
    coldWaivesEffects: coldContinue.kind === 'action',
  }
}

/** Final preselection fence: recreate after three samples; inventory partial publication honestly. */
async function runFinalFenceRefusal(input: {
  workflow: FeatureWorkflow
  createUw: CreateUw
  decodeIssue: DecodeIssue
  negativeRecordId: string
  effectsFile: string
}) {
  const recreateBeforeSelection = await input.workflow.continueFeature({
    cwd,
    reference: '#42',
    control: 'new',
    principal: false,
    contextHandoff: { negativeRecordId: input.negativeRecordId, effectsFile: input.effectsFile },
    contextEffectObserverFactory: createRecreateBeforeSelectionObserverFactory(outsidePath),
    uw: await input.createUw(),
  })
  if (recreateBeforeSelection.kind === 'action')
    throw new Error(`outside-effect-recreate-before-selection-admitted:${JSON.stringify(recreateBeforeSelection)}`)
  const publicationAfterRecreate = inventorySuccessorPublication(input.decodeIssue().operations)
  if (publicationAfterRecreate.selectSuccessorPublished)
    throw new Error(
      `outside-effect-select-successor-published-after-preselection-refuse:${JSON.stringify(publicationAfterRecreate)}`,
    )
  // Preserve partial mandate records honestly; do not delete authoritative history to unblock a follow-on.
  return {
    recreateBeforeSelection,
    publicationAfterRecreate,
    selected: {
      kind: 'skipped' as const,
      reason: 'isolated-attributed-success-required-after-partial-preselection-refuse',
    },
    planned: {
      skipped: true as const,
      reason: 'causal-product-block-risk:partial-successor-mandate-without-select-successor',
    },
  }
}

/** Isolated positive progression: attributed absent state through fresh planning publication. */
async function runPositiveFreshPlanning(input: {
  workflow: FeatureWorkflow
  createUw: CreateUw
  negativeRecordId: string
  effectsFile: string
}) {
  const selectedResult: ContinueFeatureResult = await input.workflow.continueFeature({
    cwd,
    reference: '#42',
    control: 'new',
    principal: false,
    contextHandoff: { negativeRecordId: input.negativeRecordId, effectsFile: input.effectsFile },
    contextEffectObserverFactory: createFixtureContextEffectObserverFactory(),
    uw: await input.createUw(),
  })
  if (selectedResult.kind === 'action' && selectedResult.node === 'plan') {
    const finished = await finishContextPlan(cwd, confirmedOutsideEffectOperator, selectedResult)
    if (finished.published.published !== true || finished.reviewPublished.published !== true)
      throw new Error(`outside-effect-plan-publication-incomplete:${JSON.stringify(finished)}`)
    return {
      recreateBeforeSelection: null,
      publicationAfterRecreate: null,
      selected: selectedResult,
      planned: {
        kind: 'action' as const,
        node: 'plan' as const,
        published: true as const,
        reviewPublished: true as const,
      },
    }
  }
  return {
    recreateBeforeSelection: null,
    publicationAfterRecreate: null,
    selected: selectedResult,
    planned: { selected: selectedResult, planned: false as const },
  }
}

const workflow = await loadFeatureWorkflow()
const { createUw, decodeIssue } = loadOutsideEffectWorkflow()
const { negativeRecordId, retainedNegative } = locateConservedOutsideEffectNegative(decodeIssue)
const hold = await runNegativeHoldChecks({ workflow, createUw, negativeRecordId })

rmSync(outsidePath, { force: true })
const changedVersion = changeOutsideEffectSpecBody(stateFile)
const material = await acceptContextMaterial(cwd, confirmedOutsideEffectOperator)
const acceptedPrepared: PreparedIntent = await prepareOutsideEffectIntent({
  cwd,
  negativeRecordId,
  absoluteOutsidePath: outsidePath,
})
const abandoned = await workflow.continueFeature({
  cwd,
  reference: '#42',
  control: 'abandon',
  principal: false,
  uw: await createUw(),
})
if (abandoned.kind !== 'abandoned' || !abandoned.confirmed || abandoned.failure !== undefined)
  throw new Error(`outside-effect-abandonment-unconfirmed:${JSON.stringify(abandoned)}`)
const unresolvedHandoff = await workflow.continueFeature({
  cwd,
  reference: '#42',
  control: 'new',
  principal: false,
  contextHandoff: { negativeRecordId, effectsFile: hold.unresolvedPrepared.effectsFile },
  contextEffectObserverFactory: createFixtureContextEffectObserverFactory(),
  uw: await createUw(),
})

const modeOutcome =
  mode === 'recreate-preselection'
    ? await runFinalFenceRefusal({
        workflow,
        createUw,
        decodeIssue,
        negativeRecordId,
        effectsFile: acceptedPrepared.effectsFile,
      })
    : await runPositiveFreshPlanning({
        workflow,
        createUw,
        negativeRecordId,
        effectsFile: acceptedPrepared.effectsFile,
      })

rmSync(outsidePath, { force: true })
const retainedAfter = decodeIssue().operations.find(({ record }) => record?.recordId === negativeRecordId)?.record

process.stdout.write(
  `${JSON.stringify({
    mode,
    called: produce.called,
    dispatches: produce.dispatches,
    children: produce.sdkChildren,
    errors: produce.sdkErrors,
    outsidePath,
    outsideExistsAfterProduce: produce.outsideExistsAfterProduce,
    outsideRealPathAfterProduce: produce.outsideRealPathAfterProduce,
    outsideExistsAfterCleanup: existsSync(outsidePath),
    checkoutPorcelainAfterProduce: produce.checkoutPorcelainAfterProduce,
    negativeRecordId,
    retainedNegative,
    retainedAfter: retainedAfter === undefined ? null : JSON.stringify(retainedAfter),
    observedTools: acceptedPrepared.observedTools ?? hold.unresolvedPrepared.observedTools ?? null,
    structured: acceptedPrepared.structured ?? hold.unresolvedPrepared.structured ?? null,
    continueWithoutHandoff: hold.continueWithoutHandoff,
    unresolvedHandoff,
    coldContinue: hold.coldContinue,
    coldWaivesEffects: hold.coldWaivesEffects,
    recreateBeforeSelection: modeOutcome.recreateBeforeSelection,
    publicationAfterRecreate: modeOutcome.publicationAfterRecreate,
    changedVersion,
    material,
    selected: modeOutcome.selected,
    planned: modeOutcome.planned,
    genuineSdkNegative: true,
    adapterHandoffContinuation: true,
  })}\n`,
)
