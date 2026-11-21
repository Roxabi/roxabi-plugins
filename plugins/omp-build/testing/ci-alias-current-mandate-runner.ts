import { createUwDeliveryFactReader } from '../dist/contracts.js'
import { createOperatorConfirmation } from '../omp/omp-operator-confirmation.ts'
import { loadContracts } from '../roxabi/feature-engine.ts'
import { publishSuccessorMandate, readSuccessionBasis } from '../roxabi/feature-succession.ts'
import { confirmedWorkflowBinding } from '../roxabi/fix-checkpoint-binding.ts'
import type { FixTarget, NativePort } from '../roxabi/fix-contract.ts'
import { runDefaultFix } from '../roxabi/fix-entry-default.ts'
import { createIssueAliasReadPort } from '../roxabi/fix-entry-issue-alias.ts'
import { createIdentity } from '../roxabi/fix-entry-lifecycle.ts'
import { defaultGh } from '../roxabi/fix-entry-target-core.ts'
import { createResolver } from '../roxabi/fix-entry-target-resolver.ts'
import { resolveFixTarget } from '../roxabi/fix-preparation.ts'
import { withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import { currentAccountedMandate } from '../roxabi/uw-action-selection.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { defaultGit } from '../roxabi/workflow-checkout.ts'
import { nextReviewStep } from '../skills/feature/workflow-review-state.js'
import { operatorDialogUi, operatorRootContext } from './operator-dialog-ui.ts'

const cwd = process.argv[2]
if (!cwd) throw new Error('fixture-cwd-missing')
const gh = defaultGh
const github = withRoxabiGitHubPolicy({ cwd, gh })
const resolver = createResolver(cwd, gh, 'acme/app', createIssueAliasReadPort(github))
async function interruptSuccessor() {
  const scope = { repository: 'acme/app', target: 'acme/app#42' }
  const operator = createOperatorConfirmation({
    ...operatorRootContext(cwd, { getArtifactsDir: () => process.env.HOME ?? cwd }),
    hasUI: true,
    mode: 'tui',
    ui: operatorDialogUi(async () => 'confirm'),
  } as never)
  const operations = await createInstalledUwOperations({ cwd, gh, operator })
  const abandoned = await operations.abandon(scope)
  if (abandoned.status !== 'abandoned') throw new Error(`abandon-refused:${JSON.stringify(abandoned)}`)
  const read = await operations.readUw(scope)
  const history = read.histories.find((item) => item.source.scope.target === scope.target)
  if (!history) throw new Error('successor-history-missing')
  const basis = readSuccessionBasis(history, read.histories)
  if (!basis.ok) throw new Error(`successor-basis:${JSON.stringify(basis.diagnostics)}`)
  const loaded = await loadContracts()
  if ('missing' in loaded) throw new Error(`engine-missing:${loaded.missing}`)
  const delivery = await createUwDeliveryFactReader(github).read(scope, read.histories, 'legacy-succession')
  if (!delivery.ok) throw new Error(`successor-delivery:${JSON.stringify(delivery)}`)
  const previous = basis.value.terminal.mandate.payload
  if (previous.branch === null) throw new Error('successor-branch-missing')
  let refused = false
  const interruptGh = async (directory: string, args: string[]) => {
    if (args.includes('POST') && args.some((arg) => arg.includes('kind=operator-control'))) {
      refused = true
      throw new Error('fixture-control-publication-refused')
    }
    return gh(directory, args)
  }
  const result = await publishSuccessorMandate({
    loaded,
    history,
    scope,
    basis: basis.value,
    ownSpec: previous.ownSpec,
    tier: previous.tier,
    children: previous.children,
    inheritedOwnSpecRefs: previous.inheritedOwnSpecRefs,
    coverage: previous.coverage,
    git: defaultGit(),
    gh: interruptGh,
    cwd,
    parents: [],
    target: { kind: 'branch', branch: previous.branch },
    observedPullRequests: delivery.value.facts.pullRequests,
  })
  if (!refused || result.ok) throw new Error(`successor-interruption-not-reached:${JSON.stringify(result)}`)
  return { refused, result }
}

if (process.argv[3] === 'interrupt') {
  process.stdout.write(`${JSON.stringify(await interruptSuccessor())}\n`)
} else if (process.argv[3] === 'inspect') {
  const port = createIssueAliasReadPort(github)
  const scope = { repository: 'acme/app', target: 'acme/app#42' }
  const current = currentAccountedMandate(await port.readHistory(scope))
  const binding = confirmedWorkflowBinding(await port.readBinding({ repository: 'acme/app', target: 'acme/app#7' }))
  process.stdout.write(`${JSON.stringify({ current, binding })}\n`)
} else if (process.argv[3] === 'resolve') {
  process.stdout.write(`${JSON.stringify(await resolver.resolveExplicit('#42'))}\n`)
} else {
  const contextTarget = JSON.parse(process.argv[3] ?? 'null') as FixTarget
  const reread = await resolveFixTarget({ reference: '#42', contextTarget }, resolver)
  const unexpected = (): never => {
    throw new Error('unexpected-native-dispatch')
  }
  const native: NativePort = { activate: unexpected, active: unexpected, stopOwned: unexpected, announce: unexpected }
  const operations = await createInstalledUwOperations({
    cwd,
    gh,
    operator: { executeConfirmed: async () => unexpected() },
  })
  const uw = createInstalledUwReadPort(github)
  const entry = await runDefaultFix(
    {
      cwd,
      reference: '#42',
      args: 'correct the issue',
      native,
      workflow: { nextReviewStep },
      operations,
      uw,
      github,
      gh,
    },
    createIdentity(),
    { signal: new AbortController().signal, uw: operations, onBatch: unexpected, onStarted: unexpected },
  )
  process.stdout.write(`${JSON.stringify({ reread, entry })}\n`)
}
