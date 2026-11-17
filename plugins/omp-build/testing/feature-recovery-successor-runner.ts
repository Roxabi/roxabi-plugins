import { readFileSync, writeFileSync } from 'node:fs'
import { parentCoverageSchema } from '../dist/contracts.js'
import { recordsOf } from '../engine/workflow-control.ts'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import type { ContinueFeatureInput, FeatureWorkflow, ParentCoverageRequest } from '../roxabi/feature-contract.ts'
import { continueWithParentCoverage } from '../roxabi/feature-coverage-continuation.ts'
import type { OperatorPort } from '../roxabi/uw-contract.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { acceptContextMaterial } from './feature-context-material-driver.ts'
import { finishContextPlan } from './feature-context-plan-driver.ts'
import { nativeFeatureSpec } from './feature-review-fixture.ts'
import type { SimState } from './sandbox/sandbox-types.ts'

function changeParentVersion(): string {
  const stateFile = process.env.GH_SIM_STATE
  if (!stateFile) throw new Error('Simulator state unavailable')
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as SimState
  const issue = state.issues['200']
  if (!issue) throw new Error('Parent issue unavailable')
  const changed = nativeFeatureSpec(
    { repository: 'acme/app', target: 'acme/app#200' },
    'preserves the region, timezone and locale',
  )
  issue.body = changed.body
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
  return changed.ownSpec.version
}

export async function invokeConfirmedSuccessor(
  operationName: string,
  cwd: string,
  payload: { reference: string; negativeRecordId: string },
  workflow: FeatureWorkflow,
  confirmedOperator: OperatorPort,
) {
  const sessionCwd = cwd ?? ''
  const input: ContinueFeatureInput = {
    cwd: sessionCwd,
    reference: payload.reference,
    control: operationName === 'confirmed-abandon' ? 'abandon' : 'new',
    principal: false,
    ...(operationName !== 'confirmed-abandon'
      ? { contextHandoff: { negativeRecordId: payload.negativeRecordId } }
      : {}),
    uw: await createInstalledUwOperations({ cwd: sessionCwd, operator: confirmedOperator }),
  }
  let selected = await workflow.continueFeature(input)
  let coverageRequests = 0
  let coverageRequestedParentVersion: string | undefined
  let changedParentVersion: string | undefined
  async function continueParentSuccessor() {
    const held = selected
    if (held.kind !== 'blocked' || held.continueCoverage === undefined)
      throw new Error(`Successor coverage continuation unavailable: ${JSON.stringify(held)}`)
    let proposedCoverage: ParentCoverage | undefined
    const startCount = async () => {
      const read = await createInstalledUwReadPort({ cwd: sessionCwd }).readUw({
        repository: 'acme/app',
        target: 'acme/app#200',
      })
      return read.observation.histories
        .flatMap(recordsOf)
        .filter((record) => record.kind === 'action-receipt' && record.payload.phase === 'start').length
    }
    const startsBeforeCoverage = await startCount()
    async function requestParentCoverage(request: ParentCoverageRequest) {
      if (request.parent.uw.target !== 'acme/app#200' || request.children.length !== 3)
        throw new Error('Unexpected successor parent coverage request')
      coverageRequests++
      coverageRequestedParentVersion = request.parent.version
      const coverage = parentCoverageSchema.safeParse({
        parent: request.parent,
        assignments: request.criteria.map((criterion) => ({
          criterion: criterion.id,
          children: request.children.map((child) => child.scope),
        })),
      })
      if (!coverage.success) throw new Error(`Invalid successor parent coverage: ${coverage.error.message}`)
      proposedCoverage = coverage.data
      if (operationName === 'confirmed-parent-context-successor-stale-coverage')
        changedParentVersion = changeParentVersion()
      return { kind: 'proposed' as const, coverage: coverage.data }
    }
    const continued = await continueWithParentCoverage(
      {
        workflow,
        async send(message: string) {
          throw new Error(message)
        },
        requestParentCoverage,
      },
      input,
      selected,
      false,
    )
    if (continued === undefined) throw new Error('Successor parent coverage continuation failed')
    selected = continued
    if (proposedCoverage === undefined) throw new Error('Proposed successor coverage unavailable')
    const startsAfterCoverage = await startCount()
    if (operationName === 'confirmed-parent-context-successor-stale-coverage')
      return {
        selected,
        coverageRequests,
        coverageRequestedParentVersion,
        changedParentVersion,
        startsBeforeCoverage,
        startsAfterCoverage,
      }
    const repeatedCoverage = await held.continueCoverage(proposedCoverage)
    const startsAfterRepeatedCoverage = await startCount()
    const coldRepeated = await workflow.continueFeature(input)
    const startsAfterColdRepeated = await startCount()
    return {
      selected,
      material: await acceptContextMaterial(sessionCwd, confirmedOperator, {
        started: selected,
        scope: { repository: 'acme/app', target: 'acme/app#200' },
        reference: '#200',
      }),
      coverageRequests,
      coverageRequestedParentVersion,
      repeatedCoverage,
      coldRepeated,
      startsAfterCoverage,
      startsAfterRepeatedCoverage,
      startsAfterColdRepeated,
    }
  }
  if (
    operationName === 'confirmed-parent-context-successor-material' ||
    operationName === 'confirmed-parent-context-successor-stale-coverage'
  )
    return continueParentSuccessor()
  if (operationName === 'confirmed-context-successor-plan')
    return finishContextPlan(sessionCwd, confirmedOperator, selected)
  if (operationName === 'confirmed-context-successor-material') {
    const material = await acceptContextMaterial(sessionCwd, confirmedOperator, { started: selected })
    return { selected, material }
  }
  return selected
}
