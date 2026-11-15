import { createUwDeliveryFactReader, resolveSpecEffective } from '../dist/contracts.js'
import { createOperatorConfirmation } from '../omp/omp-operator-confirmation.ts'
import { defaultGh, loadContracts } from '../roxabi/feature-engine.ts'
import { publishSuccessorMandate, readSuccessionBasis } from '../roxabi/feature-succession.ts'
import { withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import { currentAccountedMandate } from '../roxabi/uw-action-selection.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { defaultGit } from '../roxabi/workflow-checkout.ts'
import { openNativePlanStep, publishNativePlanStep } from './native-plan-producer.ts'
import { operatorDialogUi, operatorRootContext } from './operator-dialog-ui.ts'

const cwd = process.argv[2]
if (!cwd) throw new Error('fixture-cwd-missing')
const scope = { repository: 'acme/app', target: 'acme/app#42' }
const gh = defaultGh()
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
const delivery = await createUwDeliveryFactReader(withRoxabiGitHubPolicy({ cwd, gh })).read(
  scope,
  read.histories,
  'legacy-succession',
)
if (!delivery.ok) throw new Error(`successor-delivery:${JSON.stringify(delivery)}`)
const previous = basis.value.terminal.mandate.payload
if (previous.branch === null) throw new Error('successor-branch-missing')
const successor = await publishSuccessorMandate({
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
  gh,
  cwd,
  parents: [],
  target: { kind: 'branch', branch: previous.branch },
  observedPullRequests: delivery.value.facts.pullRequests,
})
if (!successor.ok) throw new Error(`successor-publish:${successor.reason}`)
const current = await operations.readUw(scope)
const currentHistory = current.histories.find((item) => item.source.scope.target === scope.target)
if (!currentHistory || current.accepted.status !== 'accepted') throw new Error('successor-accepted-history-missing')
const mandate = currentAccountedMandate(currentHistory)
if (!mandate.ok) throw new Error(`successor-mandate:${JSON.stringify(mandate.diagnostics)}`)
const effective = resolveSpecEffective({
  mode: 'current',
  own: current.accepted.value.ref,
  histories: current.histories,
  graph: current.graph,
})
if (!effective.ok) throw new Error(`successor-effective:${JSON.stringify(effective.diagnostics)}`)
const git = defaultGit()
const commit = await git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
const tree = await git(cwd, ['rev-parse', '--verify', 'HEAD^{tree}'])
if (commit.code !== 0 || tree.code !== 0) throw new Error('successor-plan-git-unavailable')
const context = {
  world: { cwd, gh, git, operations },
  scope,
  mandate: mandate.value,
  parentScopes: [],
  git: { repository: scope.repository, commit: commit.stdout.trim(), tree: tree.stdout.trim() },
}
const draft = await openNativePlanStep(context, 'plan')
const task = draft.opened.followUp.tasks.tasks[0]
if (!task || draft.opened.followUp.tasks.tasks.length !== 1) throw new Error('successor-plan-task-missing')
const plan = await publishNativePlanStep(context, draft, [
  {
    task: task.name,
    childId: 'successor-plan',
    value: {
      steps: effective.value.spec.criteria.map((criterion) => ({
        id: `step-${criterion.id}`,
        change: criterion.statement,
        doneWhen: criterion.statement,
        criterionIds: [criterion.id],
        evidence: 'Captured test evidence',
        paths: ['src/save.ts'],
      })),
      resolutions: [],
    },
  },
])
if (!plan.published.published) throw new Error(`successor-plan-result:${JSON.stringify(plan.published)}`)
const review = await openNativePlanStep(context, 'plan-review')
const tasks = review.opened.followUp.tasks.tasks
if (tasks.length !== 2) throw new Error('successor-plan-review-tasks-missing')
const reviewed = await publishNativePlanStep(
  context,
  review,
  tasks.map((item) => ({
    task: item.name,
    childId: `successor-review-${item.name}`,
    value: { outcome: 'clear' as const, blockers: [] },
  })),
)
if (!reviewed.published.published) throw new Error(`successor-plan-review:${JSON.stringify(reviewed.published)}`)
process.stdout.write(`${JSON.stringify({ predecessor: basis.value.terminal.ref })}\n`)
