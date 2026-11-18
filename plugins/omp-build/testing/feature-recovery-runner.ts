import { parentCoverageSchema } from '../dist/contracts.js'
import type { ParentCoverageRequest } from '../roxabi/feature-contract.ts'
import { continueWithParentCoverage } from '../roxabi/feature-coverage-continuation.ts'
import type { OperatorPort } from '../roxabi/uw-contract.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

await installFixtureSdkSettings(process.argv[3] ?? '')
const { loadFeatureWorkflow } = await import('../roxabi/feature-loader.ts')
const { createInstalledUwOperations } = await import('../roxabi/uw-installed-operations.ts')
const { createInstalledUwReadPort } = await import('../roxabi/uw-read-port.ts')
const { observedIncompleteNativeResult } = await import('./feature-recovery-observed-native.ts')
// The material driver also loads the SDK after the fixture settings are installed.
const { acceptContextMaterial } = await import('./feature-context-material-driver.ts')
// Plan capture also requires the installed SDK fixture settings.
const { finishContextPlan } = await import('./feature-context-plan-driver.ts')
const { invokeConfirmedSuccessor } = await import('./feature-recovery-successor-runner.ts')
const { invokeSdkDriver } = await import('./feature-recovery-sdk-dispatch.ts')
const { invokeOmpBridge } = await import('./feature-recovery-bridge-runner.ts')

type Payload = {
  reference: string
  control: 'continue' | 'resume' | 'pause' | 'abandon'
  pr: number
  code: number
  actionFile: string
  negativeRecordId: string
  effectsMode?: 'prepared' | 'intentional-unqualified-negative'
}

function numericValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
}

function effectsMode(value: unknown): Payload['effectsMode'] {
  if (value === 'prepared' || value === 'intentional-unqualified-negative') return value
  return undefined
}

function payloadFrom(raw: unknown): Payload {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('payload-invalid')
  const control = 'control' in raw ? raw.control : undefined
  const reference = 'reference' in raw ? raw.reference : undefined
  const pr = 'pr' in raw ? raw.pr : undefined
  const code = 'code' in raw ? raw.code : undefined
  const resolvedControl =
    control === 'continue' || control === 'resume' || control === 'pause' || control === 'abandon'
      ? control
      : 'continue'
  const resolvedEffectsMode = effectsMode('effectsMode' in raw ? raw.effectsMode : undefined)
  return {
    reference: typeof reference === 'string' ? reference : '',
    control: resolvedControl,
    pr: numericValue(pr, 0),
    code: numericValue(code, 1),
    actionFile: 'actionFile' in raw && typeof raw.actionFile === 'string' ? raw.actionFile : '',
    negativeRecordId: 'negativeRecordId' in raw && typeof raw.negativeRecordId === 'string' ? raw.negativeRecordId : '',
    ...(resolvedEffectsMode === undefined ? {} : { effectsMode: resolvedEffectsMode }),
  }
}

const [operation, cwd, payloadText] = process.argv.slice(2)
const payload = payloadFrom(JSON.parse(payloadText ?? '{}') as unknown)
const workflow = await loadFeatureWorkflow()

async function continueFeature() {
  const sessionCwd = cwd ?? ''
  return workflow.continueFeature({
    cwd: sessionCwd,
    reference: payload.reference,
    control: payload.control,
    principal: false,
    read: createInstalledUwReadPort({ cwd: sessionCwd }),
    uw: await createInstalledUwOperations({ cwd: sessionCwd, operator: noWriteOperator }),
  })
}

const noWriteOperator: OperatorPort = {
  async executeConfirmed() {
    throw new Error('unexpected-uw-write')
  },
}

const confirmedOperator: OperatorPort = {
  async executeConfirmed(prepared, action) {
    return {
      status: 'confirmed',
      value: await action({
        route: 'omp-native-command',
        operationId: prepared.proposal.operationId,
        proposalDigest: prepared.digest,
        confirmedAt: '2026-10-22T12:00:00.000Z',
      }),
    }
  },
}

async function continueWithCommandUw() {
  const sessionCwd = cwd ?? ''
  return workflow.continueFeature({
    cwd: sessionCwd,
    reference: payload.reference,
    control: payload.control,
    principal: false,
    uw: await createInstalledUwOperations({ cwd: sessionCwd, operator: noWriteOperator }),
  })
}

async function acceptParentChildMaterial() {
  const sessionCwd = cwd ?? ''
  const input = {
    cwd: sessionCwd,
    reference: payload.reference,
    control: payload.control,
    principal: false,
    read: createInstalledUwReadPort({ cwd: sessionCwd }),
    uw: await createInstalledUwOperations({ cwd: sessionCwd, operator: noWriteOperator }),
  }
  const first = await workflow.continueFeature(input)
  let coverageRequests = 0
  const selected = await continueWithParentCoverage(
    {
      workflow,
      async send(message: string) {
        throw new Error(message)
      },
      async requestParentCoverage(request: ParentCoverageRequest) {
        if (request.parent.uw.target !== 'acme/app#200' || request.children.length !== 3)
          throw new Error('Unexpected parent child coverage request')
        coverageRequests++
        const coverage = parentCoverageSchema.safeParse({
          parent: request.parent,
          assignments: request.criteria.map((criterion) => ({
            criterion: criterion.id,
            children: request.children.map((child) => child.scope),
          })),
        })
        if (!coverage.success) throw new Error(`Invalid parent child coverage: ${coverage.error.message}`)
        return { kind: 'proposed', coverage: coverage.data }
      },
    },
    input,
    first,
    false,
  )
  if (selected === undefined) throw new Error('Parent child material continuation failed')
  const material = await acceptContextMaterial(sessionCwd, confirmedOperator, {
    started: selected,
    scope: { repository: 'acme/app', target: 'acme/app#200' },
    reference: '#200',
  })
  return { selected, material, coverageRequests }
}

async function invokeWorkflowContinuation(operationName: string): Promise<unknown | null> {
  switch (operationName) {
    case 'recover-context':
      return workflow.continueFeature({
        cwd: cwd ?? '',
        reference: payload.reference,
        control: 'recover-context',
        principal: false,
        contextRecovery: { actionFile: payload.actionFile },
        uw: await createInstalledUwOperations({ cwd: cwd ?? '', operator: noWriteOperator }),
      })
    case 'cold-publish-uw':
      return continueWithCommandUw()
    case 'watch':
      return workflow.consumeWatchExit({
        cwd: cwd ?? '',
        pr: payload.pr,
        code: payload.code,
        reference: payload.reference,
        uw: await createInstalledUwOperations({ cwd: cwd ?? '', operator: noWriteOperator }),
      })
    case 'continuation-publish': {
      const continuation = await continueFeature()
      if (continuation.kind !== 'action') throw new Error(`continuation-not-action:${JSON.stringify(continuation)}`)
      const result = await observedIncompleteNativeResult(continuation.followUp, cwd ?? '')
      const published = await workflow.publishFeatureNativeResult({
        cwd: cwd ?? '',
        result,
        start: continuation.start,
      })
      return {
        agent: continuation.followUp.tasks.tasks[0]?.agent,
        start: continuation.start,
        operationId: continuation.followUp.operationId,
        published,
      }
    }
    case 'pause': {
      let interrupts = 0
      const result = await workflow.requestFeatureSessionPause({
        cwd: cwd ?? '',
        reason: 'session-stop',
        ...(payload.reference.length === 0 ? {} : { reference: payload.reference }),
        interrupt: async () => {
          interrupts += 1
        },
      })
      return { result, interrupts }
    }
    default:
      return null
  }
}

async function invokeWorkflowOperation(operationName: string): Promise<unknown | null> {
  switch (operationName) {
    case 'confirmed-parent-context-owner-race': {
      // The installed host loads the SDK only after this subprocess's fixture settings.
      const { contextOwnerCoverageRace } = await import('./feature-context-owner-race.ts')
      return contextOwnerCoverageRace(cwd ?? '', payload.negativeRecordId, workflow, confirmedOperator)
    }
    case 'continue':
      return continueFeature()
    case 'prepare-context-plan':
    case 'prepare-parent-context-plan': {
      const sessionCwd = cwd ?? ''
      const selected = await continueFeature()
      return finishContextPlan(
        sessionCwd,
        confirmedOperator,
        selected,
        operationName === 'prepare-parent-context-plan' ? { reference: '#200', path: 'fixture.txt' } : {},
      )
    }
    case 'accept-context-material':
      return acceptContextMaterial(cwd ?? '', confirmedOperator)
    case 'accept-existing-parent-material': {
      const uw = await createInstalledUwOperations({ cwd: cwd ?? '', operator: confirmedOperator })
      const result = await uw.acceptMaterial({ repository: 'acme/app', target: 'acme/app#200' })
      return result.status === 'accepted' ? { status: result.status } : result
    }
    case 'accept-parent-child-material':
      return acceptParentChildMaterial()
    case 'confirmed-abandon':
    case 'confirmed-context-successor':
    case 'confirmed-context-successor-material':
    case 'confirmed-parent-context-successor-material':
    case 'confirmed-parent-context-successor-stale-coverage':
    case 'confirmed-context-successor-plan':
      return invokeConfirmedSuccessor(operationName, cwd ?? '', payload, workflow, confirmedOperator)
    default:
      return invokeWorkflowContinuation(operationName)
  }
}

async function invoke(operationName: string): Promise<unknown> {
  const workflowResult = await invokeWorkflowOperation(operationName)
  return (
    workflowResult ??
    invokeSdkDriver(operationName, cwd ?? '', payload, (pause, interrupt) =>
      invokeOmpBridge(cwd ?? '', pause, interrupt),
    )
  )
}

process.stdout.write(`${JSON.stringify(await invoke(operation ?? ''))}\n`)
