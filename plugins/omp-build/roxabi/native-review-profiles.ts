export type NativeReviewProducerOutput = 'spec' | 'findings' | 'decision' | 'action-result'

export type NativeReviewProfile = {
  name: string
  description: string
  tools: string
  model: '@smol' | '@task' | '@review' | '@advisor' | '@review, @slow'
  maxTurns: number
  output: NativeReviewProducerOutput
  /** Existing generic agent body copied by the build contract. */
  sourceAgent?: string
  /** Additional product-specific semantic instructions appended to a source body. */
  instructions?: string
  /** Explicit Roxabi-only body, used only when no generic profile has the right read-only contract. */
  body?: string
}

const snapshot =
  'The task is the procedure and the index path. Read that index and the files it names in this action’s own UW snapshot. Do not expect the Spec, dossier, or earlier results in the task. Do not fetch live UW or GitHub records. Return only the structured result. The orchestrator validates and publishes; this role does not.\n\nIf required context is absent, do not invent it or produce a positive result. Return {outcome:"missing-context",missing:[{locator,reason,targets}]} with a nonempty missing list, a concrete reason, and applicable finding targets (or an empty targets array). Locator is exactly one of {kind:"file-request",repository,path,revisionHint}, {kind:"record-request",repository,target,recordKind,requestedId,selector}, or {kind:"information-request",description}; nullable fields must be present. Requests are not canonical source records.'

const dossierOnly =
  'Read only the dossier records the index names for this decision. Do not read repository code, run a shell, or write. Do not publish, push, comment, or close.'

const verifyShell =
  'Use Bash only to verify the candidate named by the index. Residual environment, gh config, git helpers, and SSH credentials may remain; that is a procedural fallback, not isolation. Worktree separation is not a credential boundary. Do not publish, push, comment, or close. Do not implement.'

const worktreeWrite =
  'Write only the confirmed worktree change named by the index. Residual environment, gh config, git helpers, and SSH credentials may remain on Bash; that is a procedural fallback, not isolation. Worktree separation is not a credential boundary. Do not publish, push, comment, or close.'

const findings = [snapshot, verifyShell, 'Return structured findings only.'].join('\n\n')

const specInstructions = [
  snapshot,
  verifyShell,
  'Judge each accepted criterion named by the index. Return specRows as canonical CriterionVerdict rows, one per criterion, plus findings only for concrete conformity gaps.',
  'Each row uses the index OwnSpecRef on target format omp-build-finding-target/1, kind criterion, and that criterion id. verdict is satisfied, missing, or unverified. criterionKind is content or behavior. bugRegression is boolean. restoration is demonstrated, not-demonstrated, or not-applicable. examined cites dossier evidence by receipt, evidenceId, and digest. Each judgment has truth, applicability, reason, and codeLink. Test codeLink is method test: judge after alone, and judge before alone when a before run is recorded. Observation codeLink is method observation and current. support is supported, unsupported, or unknown. Do not omit codeLink and do not default it to supported.',
  'A supported version link names the implementation or build this scenario actually exercised. Inspect the exact original command, the runner, scripts, imports, build selection, and the pinned or captured facts the index supplies. Account for a visible temporary edit and restore, an internal directory change, another checkout, ignored or generated output, and a remote build identity when the command can reach one. Equal endpoint samples are context only. Candidate equality, ancestry, a model or command-printed SHA, and exit 0 are not support by themselves.',
  'Supported means the supplied facts show that executed version; record the mechanism. Unsupported means the command exercised different or temporary code. Unknown means the implementation or build cannot be established; name the missing fact. Before is that run’s own version and the same regression scenario, not an unrelated infrastructure failure. A non-test observation links the observed prompt, interface, or content to the candidate version. Source reading does not prove behavior.',
  'A native sdk-view is the text presented in the SDK tool-result event, not necessarily original process bytes or complete output. Judge whether the observed material actually suffices for this criterion; an incomplete or potentially incomplete view may suffice when it contains the necessary facts, but missing necessary material stays unverified. Never infer completeness from absent truncation metadata, an artifact file, or a printed footer.',
  'Content-reading never satisfies a behavior criterion. A bug regression is demonstrated only by an observed before-fail and after-pass, or an admissible restored-behavior observation. No observation stays unverified.',
  'Missing, unknown, or unsupported linkage stays unverified or missing. Name the criterion, the evidence or run, and the missing execution-version fact. Do not return satisfied. A missing, unverified, or proofless criterion is a blocker independent of finding labels. Do not clear it by omitting a finding or by a non-blocking label. Do not emit exclusion claims, a final label, a cause, or a fix.',
  'Done when every accepted criterion has one specRows verdict and no finding stands in for a missing row.',
].join('\n\n')

const synthesisInstructions = [
  snapshot,
  dossierOnly,
  'Synthesize only confirmed contribution and recall records named by the index. Return the structured review decision. Do not invent a satisfied row from code or from memory.',
  'criterionVerdicts are refs {contributionId, target} to authenticated R-review-spec rows in this same review. Do not supply or upgrade a codeLink; only that row judges executed version. exclusionClaims cite sourceFindingId, target, exclusion {spec, index}, concern, and reason. Only additional-work against an outside-spec element is an exclusion. An accepted criterion, introduced regression, security defect, or invariant violation is not an exclusion.',
  'A missing, unverified, or proofless criterion stays a blocker independent of finding labels. Do not relabel it clear. Keep retained originals. Judge defect identity, impact, final labels, and causes from the dossier. Do not add policy.',
  'Done when every verdict you rely on is an authentic ref, every exclusion claim is one of those concerns, and findings do not replace a missing per-criterion verdict.',
].join('\n\n')

const correctionSynthesis = [
  snapshot,
  dossierOnly,
  'Synthesize only confirmed correction-intake records named by the index. Return the structured correction decision. This decision does not carry criterion verdicts or exclusion claims; do not invent them.',
  'Done when the decision covers the confirmed intake records and adds no policy.',
].join('\n\n')

const applyInstructions = [
  snapshot,
  worktreeWrite,
  'Apply only the supplied confirmed correction cause. Record each command as command, exitCode, and the stdout and stderr actually observed. Do not invent an empty stream, duplicate a combined body into both, or drop observed output. If separate streams were not observed, set proofToolCallId null and name that fact in proofUnavailableReason.',
  'proofToolCallId is the captured bash id of the runnable cause proof, or null with a concrete proofUnavailableReason. A printed SHA is not code-at-run. Before an owned commit, run lint and the existing checks plus the runnable cause proof. If any runnable proof is red, surgically restore every owned change and return failed without a commit. A runnable cause proof is never omitted as unavailable. Only NO_TEST or genuine infrastructure absence may return applied after the remaining existing checks, with proofToolCallId null and a concrete proofUnavailableReason; later falsification is SKIP, never pass.',
  'proofPaths lists explicit repo-local proof implementation paths. An empty list is valid for existing or no-test work and does not infer a semantic test. An applied result may use an empty guard inventory for no-identifiable-guard, no-test, infrastructure, or proof-only revalidation; otherwise enumerate every required production guard once. Never fabricate a toolCallId, omit an identified guard, or claim a proof that did not run.',
  'For accepted criteria actually addressed by this action, optionally return criteria declarations using the indexed criterion targets. Cite observed test toolCallIds and execution-version claims, or provide factual observation evidence with its references; otherwise declare the criterion unverified with a concrete reason. Do not carry prior implementation evidence, invent observations, or supply host provenance or captured command output.',
  'Done when outcome is applied or failed, proofToolCallId and proofUnavailableReason are the exclusive pair the result shape requires, and no GitHub write was made.',
].join('\n\n')

const falsifyInstructions = [
  snapshot,
  worktreeWrite,
  'Each dispatched falsify batch handles exactly one confirmed inventory guard named by the index. Execute its declared scenarios one at a time: make only the surgical declared-path perturbation, run the actual guard, restore normal state surgically, and rerun the normal guard.',
  'Return that guard’s factual result: removed, intendedScenario, proofFailed, and either proofToolCallId of the captured proof or a concrete proofUnavailableReason. commands record command, exitCode, and actually observed stdout and stderr. Do not invent a stream split, a toolCallId, or a pass. Do not classify a cause.',
  'Done when the result has exactly that guard and every proof id names a call that ran, or a concrete unavailable reason.',
].join('\n\n')

export const nativeReviewProfiles: readonly NativeReviewProfile[] = [
  {
    name: 'R-review-adversarial',
    description: 'Blocking structured native review profile derived from R-adversarial.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search',
    model: '@review, @slow',
    maxTurns: 30,
    output: 'findings',
    sourceAgent: 'agent-sources/R-adversarial.md',
    instructions: findings,
  },
  {
    name: 'R-review-security-auditor',
    description: 'Blocking structured native review profile derived from R-security-auditor.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search',
    model: '@review, @slow',
    maxTurns: 30,
    output: 'findings',
    sourceAgent: 'agent-sources/R-security-auditor.md',
    instructions: findings,
  },
  {
    name: 'R-review-architect',
    description: 'Blocking structured native review profile derived from R-architect.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search',
    model: '@review, @slow',
    maxTurns: 50,
    output: 'findings',
    sourceAgent: 'agent-sources/R-architect.md',
    instructions: findings,
  },
  {
    name: 'R-review-devops',
    description: 'Blocking structured native review profile derived from R-devops.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search',
    model: '@task',
    maxTurns: 50,
    output: 'findings',
    sourceAgent: 'agent-sources/R-devops.md',
    instructions: findings,
  },
  {
    name: 'R-review-tester',
    description: 'Blocking structured native review profile derived from R-tester.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search',
    model: '@task',
    maxTurns: 50,
    output: 'findings',
    sourceAgent: 'agent-sources/R-tester.md',
    instructions: findings,
  },
  {
    name: 'R-review-spec',
    description: 'Blocking structured native specification reviewer.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search',
    model: '@review',
    maxTurns: 30,
    output: 'spec',
    sourceAgent: 'agent-sources/R-adversarial.md',
    instructions: specInstructions,
  },
  {
    name: 'R-review-synthesis',
    description: 'Blocking structured native review synthesizer.',
    tools: 'read',
    model: '@review',
    maxTurns: 30,
    output: 'decision',
    body: synthesisInstructions,
  },
  {
    name: 'R-review-fix-intake',
    description: 'Blocking structured native fix intake reviewer.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search',
    model: '@task',
    maxTurns: 30,
    output: 'findings',
    sourceAgent: 'agent-sources/R-adversarial.md',
    instructions: findings,
  },
  {
    name: 'R-review-fix-synthesis',
    description: 'Blocking structured native fix synthesizer.',
    tools: 'read',
    model: '@review',
    maxTurns: 30,
    output: 'decision',
    body: correctionSynthesis,
  },
  {
    name: 'R-review-fix-apply',
    description: 'Blocking structured native correction executor.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search, write, edit',
    model: '@task',
    maxTurns: 50,
    output: 'action-result',
    sourceAgent: 'agent-sources/R-devops.md',
    instructions: applyInstructions,
  },
  {
    name: 'R-review-fix-falsify',
    description: 'Blocking structured native production-guard falsifier.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search, write, edit',
    model: '@task',
    maxTurns: 50,
    output: 'action-result',
    sourceAgent: 'agent-sources/R-tester.md',
    instructions: falsifyInstructions,
  },
  {
    name: 'R-review-recall',
    description: 'Blocking structured read-only native recall reviewer.',
    tools: 'read',
    model: '@smol',
    maxTurns: 20,
    output: 'findings',
    body: [
      snapshot,
      'Read only the index and the supplied canonical class, chunk reports, and callsites it names. Verify cross-chunk recurrence and return structured findings only.',
      'Do not write, run a command, fetch live records, or publish. Do not substitute a new classification policy.',
      'Done when the findings account for cross-chunk recurrence in the supplied reports, or state that none is evidenced.',
    ].join('\n\n'),
  },
]

export const nativePanelProfileByRole: Readonly<Record<string, string>> = {
  'R-adversarial': 'R-review-adversarial',
  'R-security-auditor': 'R-review-security-auditor',
  'R-architect': 'R-review-architect',
  'R-devops': 'R-review-devops',
  'R-tester': 'R-review-tester',
}

export const nativeFixProfileByAction = {
  intake: 'R-review-fix-intake',
  synthesis: 'R-review-fix-synthesis',
  apply: 'R-review-fix-apply',
  falsify: 'R-review-fix-falsify',
} as const
