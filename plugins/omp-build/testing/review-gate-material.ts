import path from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { acceptedConstraints, proposedConstraints } from '../engine/workflow-constraint-compatibility.ts'
import { bindExternalRef, historyFor } from '../engine/workflow-control.ts'
import type { SpecAssessment } from '../engine/workflow-output-schema.ts'
import { createOperatorConfirmation } from '../omp/omp-operator-confirmation.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { appendHistoricalAssessment, openHistoricalAssessment } from './native-assessment-history.ts'
import { operatorDialogUi, operatorRootContext } from './operator-dialog-ui.ts'
import { gateGh, setMandateIssue } from './review-gate-arrangement.ts'
import { git, type ReviewGateFixture } from './review-gate-fixture.ts'
import { AUTOMATION } from './review-gate-gh.ts'

/** Capture and confirm a genuine same-HEAD material Spec assessment in this gate's native world. */
export async function acceptGateSpecChange(fixture: ReviewGateFixture, body: string) {
  const uw = { repository: 'acme/app', target: 'acme/app#42' }
  const gh = gateGh(fixture)
  const cwd = path.join(fixture.root, 'assessment-worktree')
  git(fixture.candidate, ['worktree', 'add', '-q', '-b', 'feat/7-fixture', cwd, fixture.head])
  let confirmations = 0
  const operator = createOperatorConfirmation({
    ...operatorRootContext(cwd, { getArtifactsDir: () => fixture.root }),
    hasUI: true,
    mode: 'tui',
    ui: operatorDialogUi(async () => {
      confirmations++
      return 'confirm'
    }),
  } as unknown as ExtensionContext)
  const operations = await createInstalledUwOperations({
    cwd,
    gh,
    operator,
    readAuthor: AUTOMATION,
    pluginPin: {
      repository: 'Roxabi/roxabi-plugins',
      commit: fixture.pin,
      installedRoot: path.join(fixture.tools, 'plugins/omp-build'),
    },
  })
  const before = await operations.readUw(uw)
  if (before.observation.status !== 'complete' || before.accepted.status !== 'accepted')
    throw new Error('Gate accepted version A is unavailable')
  setMandateIssue(fixture, { body, updatedAt: '2026-10-22T00:00:00Z' })
  const ref = before.accepted.value.chain[0]?.source
  const history = historyFor(uw, before.histories)
  const bound = ref && history ? bindExternalRef(ref, history) : null
  if (!bound?.ok || bound.value.kind !== 'mandate') throw new Error('Gate assessment mandate is unavailable')
  const started = await openHistoricalAssessment({
    world: { cwd, gh, operations },
    scope: uw,
    mandate: bound.value,
    commit: fixture.head,
  })
  const { exact } = started
  if (
    exact.accepted.children.length ||
    exact.proposed.children.length ||
    exact.accepted.inheritedOwnSpecRefs.length ||
    exact.proposed.inheritedOwnSpecRefs.length ||
    exact.attachedChildren.length ||
    exact.attachedWayfinders.length
  )
    throw new Error('Unexpected gate assessment constraint closure')
  const constraints = [
    ...acceptedConstraints(exact.accepted.ref, exact.accepted.snapshot.spec, true),
    ...proposedConstraints(uw, exact.proposed.snapshot.spec),
  ]
  const unique = [...new Map(constraints.map((constraint) => [canonicalValueDigest(constraint), constraint])).values()]
  const first = unique[0]
  if (!first) throw new Error('Gate assessment constraints are empty')
  const judgment: SpecAssessment = {
    classification: 'material',
    compatibility: {
      state: 'consistent',
      examined: [first, ...unique.slice(1)],
      references: [],
      reason: 'The existing and clarified criterion are compatible.',
    },
  }
  const head = git(cwd, ['rev-parse', 'HEAD'])
  if (head !== fixture.head) throw new Error('Gate assessment changed the candidate HEAD')
  const result = await appendHistoricalAssessment({ cwd, gh, operations }, uw, started, 'gate-assess-child', judgment)
  const accepted = await operations.acceptMaterial(uw)
  if (accepted.status !== 'accepted' || accepted.value.accepted.status !== 'accepted')
    throw new Error(`Gate material acceptance failed: ${JSON.stringify(accepted)}`)
  if (
    confirmations !== 1 ||
    canonicalValueDigest(before.accepted.value.ref) === canonicalValueDigest(accepted.value.accepted.value.ref)
  )
    throw new Error('Gate material acceptance did not confirm a new own-Spec version')
  return { before, after: accepted.value, started, result, confirmations }
}
