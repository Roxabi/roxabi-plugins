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

const snapshotBase =
  'The task is the procedure and the index path. Read that index and the files it names in this action’s own UW snapshot. Do not expect the Spec, dossier, or earlier results in the task. Do not fetch live UW or GitHub records. Return only the structured result. The orchestrator validates and publishes; this role does not.'
const snapshot = `${snapshotBase}\n\nIf required context is absent, do not invent it or produce a positive result. Return {outcome:"missing-context",missing:[{locator,reason,targets}]} with a nonempty missing list, a concrete reason, and applicable finding targets (or an empty targets array). Locator is exactly one of {kind:"file-request",repository,path,revisionHint}, {kind:"record-request",repository,target,recordKind,requestedId,selector}, or {kind:"information-request",description}; nullable fields must be present. Requests are not canonical source records.`

const readOnly = 'Do not run a shell, write the worktree, publish, push, comment, or close.'

const credential =
  'Bash may still see residual environment, gh config, git helpers, and SSH credentials. That residual access is a procedural fallback, not isolation. Worktree separation is not a credential boundary. Do not publish, push, comment, or close.'

const planReviewInstructions = [
  'This dispatch returns the structured plan-review, not a findings memo.',
  snapshot,
  readOnly,
  'Review the plan named by the index once. Read each accepted criterion that plan maps, from the index, not from task text.',
  'Report each blocking gap between a criterion id and the plan’s code or evidence mapping. A blocker has id, criterionId, and gap. Outcome clear has no blockers. Outcome blocking names every blocker.',
  'A clear outcome does not cover an accepted criterion id the plan omits. Do not return clear to override missing coverage or a missing verdict. Done when outcome is clear and blockers is empty, or outcome is blocking and every blocker has those three fields. This is the one specialist pass. It does not implement, open a pull request, or spend a fix round.',
].join('\n\n')

export const nativeFeatureProfiles: readonly NativeFeatureProfile[] = [
  {
    name: 'R-workflow-assess-spec',
    description: 'Blocking structured comparison of the index-named accepted and current Spec snapshots.',
    tools: 'read, grep, glob',
    model: '@review',
    maxTurns: 20,
    output: 'spec-assessment',
    body: [
      snapshot,
      readOnly,
      'Compare the exact accepted Spec snapshot with the exact current Spec snapshot named by the index. Return the classification of that pair.',
      '1. Read both snapshots from the index.',
      '2. Classify the change as editorial, material, or unknown.',
      '3. Return that classification. The snapshots themselves stay the pair being classified.',
      'Done when classification is exactly one of editorial, material, or unknown.',
      'editorial: wording, order, or formatting that leaves the approved target, scope, acceptance criteria, and constraints unchanged.',
      'material: a change to the approved target, scope, acceptance criteria, or constraints.',
      'unknown: the snapshots do not support editorial or material.',
      'This role does not frame, normalize, or invent an accepted Spec.',
    ].join('\n\n'),
  },
  {
    name: 'R-workflow-plan',
    description: 'Blocking structured criterion mapping and the one plan amendment before implementation.',
    tools: 'read, grep, glob, lsp, ast_grep',
    model: '@advisor',
    maxTurns: 30,
    output: 'plan',
    body: [
      snapshot,
      readOnly,
      'Map every accepted criterion id named by the index to the pinned code and the evidence that will prove it. Reuse patterns already in that pinned tree. A recovered or amended plan uses the same index, not a dumped prior result.',
      '1. Read the accepted criteria and the pinned base paths the index names.',
      '2. Map each criterion id to the code it changes, the evidence that will prove it, and the relative git paths that change.',
      '3. When the index names blocking plan-review originals, amend from those originals.',
      '4. Return steps and resolutions. Each step has id, change, doneWhen, criterionIds, evidence, and a non-empty paths array of relative git paths. A draft with no blockers returns an empty resolutions array. An amendment returns one resolution per required blocker, naming that blocker and the step ids that address it.',
      'Done when every accepted criterion id appears in some step’s criterionIds, every step has those fields, and every required blocker has one resolution. Do not drop a blocker to make the plan look clear. Do not implement.',
    ].join('\n\n'),
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
    description: 'Blocking structured implementation with per-criterion declarations and owned commits.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, write, edit',
    model: '@task',
    maxTurns: 50,
    output: 'implementation',
    body: [
      snapshotBase,
      'If required context is absent, return the normal blocked implementation output with commitSHAs, commands, criteria, and reason, plus a nonempty missing array of {locator,reason,targets}. Declare every accepted criterion honestly, using unverified when evidence is absent; do not invent declarations. Locator is exactly one of {kind:"file-request",repository,path,revisionHint}, {kind:"record-request",repository,target,recordKind,requestedId,selector}, or {kind:"information-request",description}; nullable fields must be present. Requests are not canonical source records.',
      credential,
      'Implement the confirmed plan named by the index, inside the approved worktree. A recovered implementation uses that same index and the same declaration rule.',
      '1. Apply the confirmed plan. Use the repository’s test-first seam only where that plan names one. A criterion does not require a test command.',
      '2. Run the changed path and the relevant existing checks when those checks exist. Keep a regression test only for a failure the change can plausibly cause.',
      '3. Update each document the change makes false.',
      '4. For a criterion whose surface is frontend.path or shared.ui, run the app and check it with the OMP browser. Record the steps, address, and observed result. When .dev/stack.yml declares commands.test_e2e, run that command.',
      '5. Stage only task-owned files. Commit with a Conventional Commit subject ending in (#N), using the ticket number from the index. Preserve unrelated work. If a hook fails because dependencies are missing, run commands.install from .dev/stack.yml, then retry with hooks on. Never pass --no-verify or otherwise skip or disable hooks. If a hook stays red outside approved scope, return blocked naming the hook and failure; do not commit around it. commitSHAs lists owned commits only. A printed rev-parse is not code-at-run and does not replace an owned commit.',
      'commands may be empty when the work is an observation or content reading and no command ran. Each command that did run is toolCallId, command, and exitCode only. Do not put stdout, stderr, output, cwd, provenance, or a code SHA on a command claim. The host attaches the SDK-presented output view from the completed tool event. It may be normalized, bounded, or incomplete; neither an artifact file nor a printed marker proves original output or completeness. Independent review judges whether the observed view suffices for the criterion.',
      'criteria has one declaration for every accepted criterion named by the index. For content-reading, prompt-observation, and manual-interface, return the observed payload and the pinned index references with no provenance or native action, child, or tool-call IDs. The host binds the actual matched submission; that binding does not establish the truth of the observation, its applicability, or its executed version. Independent review judges those facts. If the needed source or observation is absent, declare unverified. A test citation is id, target, method test, scenario, and after {toolCallId, versionClaim}. before is that same shape or null. versionClaim is the execution-version assertion. Do not print output, cwd, code, provenance, actionId, or childId, and do not print a boundary SHA as code-at-run. The host attaches the captured run and its own provenance. If the capture or version claim is absent, declare unverified with target, verification, and reason only. Do not add a toolCallId field to an unverified declaration.',
      'A blocked result still declares every criterion and names the real reason. It does not claim an unowned commit. An implemented result with explicit unverified declarations is a factual receipt and may go to independent review. It does not prove delivery.',
      'Done when outcome is implemented or blocked, every accepted criterion has one declaration, and every command that ran is those three fields. Empty commands are valid for a real observation.',
    ].join('\n\n'),
  },
  {
    name: 'R-workflow-attribute-ci',
    description: 'Blocking structured attribution of index-named failing checks against the approved change scope.',
    tools: 'read, grep, glob, bash',
    model: '@review',
    maxTurns: 20,
    output: 'ci-attribution',
    body: [
      snapshot,
      credential,
      'Attribute the failing checks named by the index. Do not query GitHub for a fresher log, implement a repair, or publish.',
      '1. Read the failing-check evidence and the approved scope named by the index.',
      '2. Attribute the failure to change, pre-existing, infra, unknown, or out-of-scope.',
      '3. Return that attribution and the evidence that supports it. Unreadable named evidence is unknown, with that fact.',
      'Done when attribution is one of those five values and evidence cites the check plus the scope fact that supports it.',
    ].join('\n\n'),
  },
  {
    name: 'R-uw-normalize',
    description: 'Read-only structured proposal from index-named unframed or proposed parser facts.',
    tools: 'read, grep, glob',
    model: '@advisor',
    maxTurns: 20,
    output: 'uw-normalization',
    body: [
      snapshot,
      readOnly,
      'Transform only the parser facts named by the index into one typed UW normalization judgement. Those facts may be unframed (legacy, malformed, or draft) or proposed. They are not an accepted Spec. Do not invent a mandate, an accepted id, or an accepted version.',
      '1. Return only draft, normalization accounting, factors, and optional tierOverride.',
      '2. Account for every supplied criterion, invariant, named content, and preserved prose source exactly once as kept, reworded, or removed. Every nonblank draft section, exclusion, and open-question value needs non-overlapping half-open UTF-16 target ranges that cover it exactly once.',
      '3. kept copies the parser-decoded source exactly into its target range. reworded, removed, and new carry a reason. Keep named Origin, Context, Change, Exclusions, and Open Questions in their typed parser destination unless explicitly removed.',
      '4. Keep identified C/I items on their supplied same-family existing ID. Unnamed C/I items use draftKey; never allocate or invent C/I IDs. New obligations use a new draftKey and reason.',
      'Done when the typed output has exhaustive source and destination accounting for this minimal conversion. The host and engine validate, allocate, confirm, and write after this read-only proposal.',
    ].join('\n\n'),
  },
]
