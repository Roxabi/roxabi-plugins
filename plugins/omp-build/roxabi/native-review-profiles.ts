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

export const nativeReviewProfiles: readonly NativeReviewProfile[] = [
  {
    name: 'R-review-adversarial',
    description: 'Blocking structured native review profile derived from R-adversarial.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search',
    model: '@review, @slow',
    maxTurns: 30,
    output: 'findings',
    sourceAgent: 'agent-sources/R-adversarial.md',
  },
  {
    name: 'R-review-security-auditor',
    description: 'Blocking structured native review profile derived from R-security-auditor.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search',
    model: '@review, @slow',
    maxTurns: 30,
    output: 'findings',
    sourceAgent: 'agent-sources/R-security-auditor.md',
  },
  {
    name: 'R-review-architect',
    description: 'Blocking structured native review profile derived from R-architect.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search',
    model: '@review, @slow',
    maxTurns: 50,
    output: 'findings',
    sourceAgent: 'agent-sources/R-architect.md',
  },
  {
    name: 'R-review-devops',
    description: 'Blocking structured native review profile derived from R-devops.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search',
    model: '@task',
    maxTurns: 50,
    output: 'findings',
    sourceAgent: 'agent-sources/R-devops.md',
  },
  {
    name: 'R-review-tester',
    description: 'Blocking structured native review profile derived from R-tester.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search',
    model: '@task',
    maxTurns: 50,
    output: 'findings',
    sourceAgent: 'agent-sources/R-tester.md',
  },
  {
    name: 'R-review-spec',
    description: 'Blocking structured native specification reviewer.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search',
    model: '@review',
    maxTurns: 30,
    output: 'spec',
    sourceAgent: 'agent-sources/R-adversarial.md',
    instructions:
      'Phase 2 only: identify verifiable review obligations and concrete specification-conformity gaps or blockers against the supplied baseline and candidate policy. Preserve policy IDs verbatim. The report may supply the schema-required provisional original-finding label, but never a final label, impact, merge, cause, fix, or new policy. Return only the static structured spec.',
  },
  {
    name: 'R-review-synthesis',
    description: 'Blocking structured native review synthesizer.',
    tools: 'read, grep, glob',
    model: '@review',
    maxTurns: 30,
    output: 'decision',
    sourceAgent: 'agent-sources/R-adversarial.md',
    instructions:
      'Synthesize only confirmed contribution and recall records under supplied policy IDs. Never rewrite or discard retained originals. Judge defect identity, impact, final labels, cause memberships, and correction plans from their evidence; return the static structured decision without adding policy.',
  },
  {
    name: 'R-review-fix-intake',
    description: 'Blocking structured native fix intake reviewer.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search',
    model: '@task',
    maxTurns: 30,
    output: 'findings',
    sourceAgent: 'agent-sources/R-adversarial.md',
  },
  {
    name: 'R-review-fix-synthesis',
    description: 'Blocking structured native fix synthesizer.',
    tools: 'read, grep, glob',
    model: '@review',
    maxTurns: 30,
    output: 'decision',
    sourceAgent: 'agent-sources/R-advisor.md',
    instructions:
      'Synthesize only confirmed correction-intake records and return the static structured correction decision.',
  },
  {
    name: 'R-review-fix-apply',
    description: 'Blocking structured native correction executor.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search, write, edit',
    model: '@task',
    maxTurns: 50,
    output: 'action-result',
    sourceAgent: 'agent-sources/R-devops.md',
    instructions:
      'Apply only the supplied confirmed correction cause. Record every command, its exit status, stdout, stderr, and produced commit SHA. Before an owned commit, run lint/existing checks and the runnable cause proof. If any runnable proof is red, surgically restore every owned change and return failed without a commit. A runnable cause proof may never be omitted as unavailable. Only NO_TEST or genuine infrastructure absence may return applied after the remaining existing checks, with proofToolCallId null and a concrete proof-unavailable reason; later falsification is SKIP, never pass. Report explicit repo-local proof implementation paths in proofPaths; an empty list is valid for existing/no-test work and does not infer a semantic test. An applied result may declare an empty guard inventory for no-identifiable-guard/no-test/infrastructure/proof-only revalidation; otherwise enumerate every required production guard exactly once with its ID, path set, and intended scenario. proofToolCallId must identify one dedicated Bash repository-native check, never an edit, git commit, push, or combined command. Select that actual proof tool-call ID as evidence or return null with a concrete proof-unavailable reason. Never fabricate an ID, omit an identified guard, or claim a proof that did not run.',
  },
  {
    name: 'R-review-fix-falsify',
    description: 'Blocking structured native production-guard falsifier.',
    tools: 'read, grep, glob, bash, lsp, ast_grep, web_search, write, edit',
    model: '@task',
    maxTurns: 50,
    output: 'action-result',
    sourceAgent: 'agent-sources/R-tester.md',
    instructions:
      'Each dispatched falsify batch handles exactly one confirmed inventory guard. Execute its declared scenarios one at a time: make only the surgical declared-path perturbation, run the actual guard, capture every command and observed exit/output, restore normal state surgically, and rerun the normal guard. Return its sole factual guard-ID result with removal/scenario/proof outcome and per-fact proof tool-call ID or a concrete proof-unavailable reason. Assess guard semantics only from actual outputs; never fabricate an ID, omit a guard, invent a pass, or classify a cause.',
  },
  {
    name: 'R-review-recall',
    description: 'Blocking structured read-only native recall reviewer.',
    tools: 'read, find, grep, glob, web_search',
    model: '@smol',
    maxTurns: 20,
    output: 'findings',
    body: 'Read only the supplied canonical class, chunk reports, and callsites. Verify cross-chunk recurrence and return structured findings only. Never write, mutate, run commands, or substitute a new classification policy.',
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
