import { chmodSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ActionInputs } from '../../engine/action-input-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import { mechanicalSpecDelta } from '../../engine/workflow-spec-assessment.ts'
import { installFixtureSdkSettings } from '../../testing/native-sdk-settings-fixture.ts'

const [cwd = '', raw = '{}', actionId = ''] = process.argv.slice(2)
await installFixtureSdkSettings(cwd)
// Load the native runtime only after fixture SDK settings are installed.
const { actionRequest, observeHeadCode, uwSubject } = await import('../../roxabi/delivery-action.ts')
const { sealReceipt } = await import('../../roxabi/feature-action-receipt.ts')
const { defaultGh, loadContracts } = await import('../../roxabi/feature-engine.ts')
const { withRoxabiGitHubPolicy } = await import('../../roxabi/github-policy.ts')
const { readAssessmentSpecFacts } = await import('../../roxabi/uw-current-facts.ts')
const { createInstalledUwOperations } = await import('../../roxabi/uw-installed-operations.ts')
const { defaultGit } = await import('../../roxabi/workflow-checkout.ts')
const operations = await createInstalledUwOperations({
  cwd,
  operator: {
    async executeConfirmed() {
      throw new Error('unexpected-uw-write')
    },
  },
})

async function prepareAssessment(uw: Scope) {
  const read = await operations.readUw(uw)
  if (read.accepted.status !== 'accepted') throw new Error('accepted assessment operands missing')
  const { ref, snapshot, tier, children, inheritedOwnSpecRefs, coverage } = read.accepted.value
  if (ref.sourceAccepted.kind !== 'mandate') throw new Error('assessment fixture mandate missing')
  const accepted = { ref, snapshot, tier, children, inheritedOwnSpecRefs, coverage }
  const current = await readAssessmentSpecFacts({ uw, read, coverage: null })
  if (!current.ok) throw new Error(`proposed assessment operands missing: ${JSON.stringify(current)}`)
  const proposed = current.value.currentSpec
  const exactInputs = {
    format: 'omp-build-spec-assessment/3' as const,
    accepted,
    proposed,
    attachedChildren: [],
    attachedWayfinders: [],
    childOwnSources: [],
    identityAllocations: current.value.identityAllocations,
    mechanical: mechanicalSpecDelta(accepted, proposed),
  }
  const code = await observeHeadCode(defaultGit(), cwd, uw.repository)
  if (!code.ok) throw new Error(code.reason)
  const operationId = 'initial-assessment-action'
  const origin = { kind: 'native-current' as const }
  const prepared = await operations.prepareAction(
    actionRequest({
      actionId: operationId,
      purpose: 'assess-spec',
      subject: uwSubject(uw, null),
      code: code.code,
      operands: { action: 'assess-spec', origin, exactInputs },
    }),
  )
  if (!prepared.ok) throw new Error(`assessment preparation refused: ${JSON.stringify(prepared.diagnostics)}`)
  const engine = await loadContracts()
  if ('missing' in engine) throw new Error(`contracts missing: ${engine.missing}`)
  const gh = defaultGh()
  const histories = await engine.readComposedWorkflowHistory([uw], withRoxabiGitHubPolicy({ cwd, gh }))
  if (!histories.ok) throw new Error(`assessment history missing: ${JSON.stringify(histories)}`)
  const history = histories.histories.find(({ source }) => source.scope.target === uw.target)
  if (history === undefined) throw new Error('assessment target history missing')
  const result = await sealReceipt({
    loaded: engine,
    history,
    scope: uw,
    cwd,
    gh,
    parents: [],
    operationId,
    mandate: { ...ref.sourceAccepted, kind: 'mandate' },
    prepared: prepared.value,
    origin,
    exactInputs,
  })
  if (result.kind !== 'action') throw new Error(`assessment START refused: ${result.reason}`)
  const before = await operations.verifyAction(prepared.value.snapshot)
  const file = join(dirname(prepared.value.snapshot.indexPath), 'action/exact-inputs.json')
  chmodSync(file, 0o644)
  writeFileSync(file, '{"tampered":true}')
  chmodSync(file, 0o444)
  const after = await operations.verifyAction(prepared.value.snapshot)
  return { ...result, verification: { before, after } }
}

function replay(reviewed: ActionInputs) {
  const manifest = reviewed.manifest
  return operations.replayActionInputs({
    reviewed,
    request: {
      actionId,
      purpose: manifest.purpose,
      subject: manifest.subject,
      code: manifest.code,
      stageSources: reviewed.stageSources,
      expandedContext: manifest.expandedContext,
      operands: manifest.operands,
    },
  })
}

const decoded = JSON.parse(raw)
const result =
  actionId === 'prepare' ? await prepareAssessment(decoded as Scope) : await replay(decoded as ActionInputs)
process.stdout.write(`${JSON.stringify(result)}\n`)
