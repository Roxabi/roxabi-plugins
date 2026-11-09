import path from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { acceptedConstraints, proposedConstraints } from '../engine/workflow-constraint-compatibility.ts'
import type { SpecAssessment } from '../engine/workflow-output-schema.ts'
import { createOperatorConfirmation } from '../omp/omp-operator-confirmation.ts'
import { publishFeatureNativeResult } from '../roxabi/feature-result.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { continueFeature } from '../roxabi/workflow.ts'
import type { GitRunner } from '../roxabi/workflow-checkout.ts'
import { captureNativeTask } from './native-action-capture.ts'
import { operatorDialogUi } from './operator-dialog-ui.ts'
import { gateGh, setMandateIssue } from './review-gate-arrangement.ts'
import { git, type ReviewGateFixture } from './review-gate-fixture.ts'
import { AUTOMATION } from './review-gate-gh.ts'

/** Capture and confirm a genuine same-HEAD material Spec assessment in this gate's native world. */
export async function acceptGateSpecChange(fixture: ReviewGateFixture, body: string) {
  const uw = { repository: 'acme/app', target: 'acme/app#42' }
  const gh = gateGh(fixture)
  const cwd = path.join(fixture.root, 'assessment-worktree')
  git(fixture.candidate, ['worktree', 'add', '-q', '-b', 'feat/7-fixture', cwd, fixture.head])
  const gitPort: GitRunner = async (cwd, args) => {
    try {
      return { code: 0, stdout: git(cwd, args), stderr: '' }
    } catch (error) {
      return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
    }
  }
  let confirmations = 0
  const operator = createOperatorConfirmation({
    agent: { kind: 'main', depth: 0 },
    hasUI: true,
    mode: 'tui',
    ui: operatorDialogUi(async () => {
      confirmations++
      return 'confirm'
    }),
    localProtocolOptions: { getArtifactsDir: () => fixture.root },
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
  const started = await continueFeature({
    cwd,
    reference: '42',
    control: 'continue',
    principal: false,
    gh,
    git: gitPort,
    uw: operations,
  })
  if (started.kind !== 'action' || started.node !== 'assess-spec')
    throw new Error(`Gate assessment did not start: ${JSON.stringify(started)}`)
  const operands = started.followUp.tasks.tasks[0]?.action.inputs.manifest.operands
  if (operands?.action !== 'assess-spec' || operands.origin.kind !== 'native-current')
    throw new Error('Gate assessment inputs are unavailable')
  const exact = operands.exactInputs
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
  const tree = git(cwd, ['rev-parse', 'HEAD^{tree}'])
  const captured = await captureNativeTask({
    batch: started.followUp,
    cwd,
    childId: 'gate-assess-child',
    command: 'inspect gate assessment',
    toolCallId: 'gate-assess',
    output: 'Observed accepted and proposed criteria',
    expectedRuns: 0,
    claim: JSON.parse(JSON.stringify(judgment)),
    git: { repository: uw.repository, commit: head, tree },
  })
  const publication = await publishFeatureNativeResult({
    cwd,
    start: started.start,
    result: captured,
    gh,
    git: gitPort,
  })
  if (!publication.published) throw new Error(`Gate assessment publication failed: ${JSON.stringify(publication)}`)
  const accepted = await operations.acceptMaterial(uw)
  if (accepted.status !== 'accepted' || accepted.value.accepted.status !== 'accepted')
    throw new Error(`Gate material acceptance failed: ${JSON.stringify(accepted)}`)
  if (
    confirmations !== 1 ||
    canonicalValueDigest(before.accepted.value.ref) === canonicalValueDigest(accepted.value.accepted.value.ref)
  )
    throw new Error('Gate material acceptance did not confirm a new own-Spec version')
  return { before, after: accepted.value, started, publication, confirmations }
}
