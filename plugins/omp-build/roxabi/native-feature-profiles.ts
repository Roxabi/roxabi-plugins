export type NativeFeatureProducerOutput =
  | 'spec-assessment'
  | 'plan'
  | 'plan-review'
  | 'implementation'
  | 'ci-attribution'
  | 'uw-normalization'
export type NativeFeatureProfile = {
  name: string
  description: string
  tools: string
  model: '@smol' | '@task' | '@review' | '@advisor' | '@review, @slow'
  maxTurns: number
  output: NativeFeatureProducerOutput
  sourceAgent?: string
  instructions?: string
  body?: string
}

/**
 * One read-only plan review is these two specialist profiles, or the existing
 * specialist agent names the coordinator already puts on that batch. The host
 * announces that batch unchanged. It is not one planner task and not a review loop.
 */
export const nativePlanReviewProfileNames = ['R-workflow-plan-architect', 'R-workflow-plan-adversarial'] as const

export const nativePlanReviewSpecialistAgents = ['R-architect', 'R-adversarial'] as const

const planReviewInstructions =
  'Review the supplied plan once and return only the structured plan-review. Read the plan and each Spec criterion it maps. Report each blocking gap between a criterion and the plan’s code or evidence mapping. Done when outcome is clear and blockers is empty, or outcome is blocking and every blocker names its id, criterion, and gap. This is the one specialist pass. It does not open a pull request, write a review marker, or spend a fix round.'

export const nativeFeatureProfiles: readonly NativeFeatureProfile[] = [
  {
    name: 'R-workflow-assess-spec',
    description: 'Blocking structured comparison of the accepted and current Spec snapshots.',
    tools: 'read, grep, glob',
    model: '@review',
    maxTurns: 20,
    output: 'spec-assessment',
    body: [
      'Compare the exact accepted Spec snapshot with the exact current Spec snapshot in the task. Return the classification of that pair.',
      '',
      '1. Read both snapshots as given.',
      '2. Classify the change as editorial, material, or unknown.',
      '3. Return that classification. The snapshots themselves stay the pair being classified.',
      '',
      'Done when classification is exactly one of editorial, material, or unknown.',
      '',
      'editorial: wording, order, or formatting that leaves the approved target, scope, acceptance criteria, and constraints unchanged.',
      'material: a change to the approved target, scope, acceptance criteria, or constraints.',
      'unknown: the snapshots do not support editorial or material.',
    ].join('\n'),
  },
  {
    name: 'R-workflow-plan',
    description: 'Blocking structured criterion mapping and the one plan amendment before implementation.',
    tools: 'read, grep, glob, lsp, ast_grep',
    model: '@advisor',
    maxTurns: 30,
    output: 'plan',
    body: [
      'Map every acceptance criterion in the task to the affected code and the evidence that proves it. Reuse the repository’s existing patterns. When the task includes blocking plan-review originals, amend this plan so each blocker is resolved, or stop with that blocker named. Return the structured plan.',
      '',
      '1. Read the approved Spec and the current code the criteria name.',
      '2. Map each criterion to the code it changes, the evidence that will prove it, and the relative git paths that change.',
      '3. When blocking plan-review originals are in the task, amend the plan from those originals.',
      '4. Return steps. Each step has id, change, doneWhen, criterion, evidence, and a non-empty paths array of relative git paths.',
      '',
      'Done when every criterion has one step with those fields, and any supplied blocker is either resolved in a step or named as unresolved in doneWhen.',
      '',
      'This dispatch returns the plan. The one read-only architect and adversarial review is a separate two-task batch. Implementation is a separate batch.',
    ].join('\n'),
  },
  {
    name: 'R-workflow-plan-architect',
    description: 'One read-only structured plan review by the existing architect specialist.',
    tools: 'read, grep, glob, lsp, ast_grep',
    model: '@review, @slow',
    maxTurns: 30,
    output: 'plan-review',
    sourceAgent: 'agent-sources/R-architect.md',
    instructions: planReviewInstructions,
  },
  {
    name: 'R-workflow-plan-adversarial',
    description: 'One read-only structured plan review by the existing adversarial specialist.',
    tools: 'read, grep, glob, lsp, ast_grep',
    model: '@review, @slow',
    maxTurns: 30,
    output: 'plan-review',
    sourceAgent: 'agent-sources/R-adversarial.md',
    instructions: planReviewInstructions,
  },
  {
    name: 'R-workflow-implement',
    description: 'Blocking structured implementation with changed-path proof and owned commits.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, write, edit',
    model: '@task',
    maxTurns: 50,
    output: 'implementation',
    body: [
      'Implement the confirmed plan inside the approved scope. Return the structured implementation result.',
      '',
      '1. Apply the confirmed plan. Use the repository’s test-first seam where that plan names one.',
      '2. Run the actual changed path and the relevant existing checks. Keep a regression test only for a failure the change can plausibly cause.',
      '3. Update each document the change makes false.',
      '4. For a criterion whose surface is frontend.path or shared.ui, run the app and check it with the OMP browser. Record the steps, URL, and observed result in commands. When .dev/stack.yml declares commands.test_e2e, run that command; that command is the proof.',
      '5. Stage only task-owned files. Commit with a Conventional Commit subject ending in (#N), using the ticket number from the task. Preserve unrelated work. If a hook fails because dependencies are missing, run commands.install from .dev/stack.yml, then retry with hooks on. Never pass --no-verify or otherwise skip or disable hooks (including -n, LEFTHOOK=0, or core.hooksPath). If a hook stays red outside approved scope, return blocked naming the hook and failure; do not commit around it. Put each owned commit SHA in commitSHAs.',
      '',
      'Done when outcome is implemented or blocked, every command you ran is listed with only its captured toolCallId, exact bash command in command, and exitCode, and each owned commit subject ends with (#N). The host retains the captured stdout, stderr, and working directory; do not duplicate them in the structured command claims. A listed exitCode is a claim. The host binds that toolCallId to one captured bash call, then checks the command text, that call’s observed directory, and the exit. The same command text may repeat after a red run; each run keeps its own id. Do not reuse an earlier id or an earlier directory. An uncaptured, deferred, or mismatched command does not pass. A blocked result names the reason and does not claim an unowned commit.',
    ].join('\n'),
  },
  {
    name: 'R-workflow-attribute-ci',
    description: 'Blocking structured attribution of a failing check against the approved change scope.',
    tools: 'read, grep, glob, bash',
    model: '@review',
    maxTurns: 20,
    output: 'ci-attribution',
    body: [
      'Read the failing check evidence and the approved change scope in the task. Return the structured attribution.',
      '',
      '1. Read the failing check evidence and the approved scope.',
      '2. Attribute the failure to change, pre-existing, infra, unknown, or out-of-scope.',
      '3. Return that attribution and the evidence that supports it.',
      '',
      'Done when attribution is one of those five values and evidence cites the check plus the scope fact that supports it.',
    ].join('\n'),
  },
  {
    name: 'R-uw-normalize',
    description: 'Read-only structured proposal for minimal existing-UW normalization.',
    tools: 'read, grep, glob',
    model: '@advisor',
    maxTurns: 20,
    output: 'uw-normalization',
    body: [
      'Transform only the supplied parser facts into one typed UW normalization judgement.',
      '',
      '1. Return only draft, normalization accounting, factors, and optional tierOverride.',
      '2. Account for every supplied criterion, invariant, named content, and preserved prose source exactly once as kept, reworded, or removed. Every nonblank draft section, exclusion, and open-question value needs non-overlapping half-open UTF-16 target ranges that cover it exactly once.',
      '3. kept copies the parser-decoded source exactly into its target range. reworded, removed, and new carry a reason. Keep named Origin, Context, Change, Exclusions, and Open Questions in their typed parser destination unless explicitly removed.',
      '4. Keep identified C/I items on their supplied same-family existing ID. Unnamed C/I items use draftKey; never allocate or invent C/I IDs. New obligations use a new draftKey and reason.',
      '',
      'Done when the typed output has exhaustive source and destination accounting for this minimal conversion.',
      '',
      'Do not write files, publish records, mutate GitHub, create issues, invent operator approval, add scope, or perform freeform cadrage. The host and engine validate, allocate, confirm, and write after this read-only proposal.',
    ].join('\n'),
  },
]
