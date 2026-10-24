import {
  ASSERTLEDGER_CONFIG,
  errorMessage,
  type Gh,
  type Git,
  gitError,
  isMap,
  jsonField,
  oneLine,
  type Refusal,
  refuse,
} from './proof-base'
import type { CandidateFacts } from './proof-candidate-contract'
import type { Deps, Read } from './proof-context'
import { reviewedRecord } from './proof-records'
import type { SelectedRecord, Target } from './proof-review-contract'
import type { Step } from './proof-semctx-protocol'
import { isStep } from './proof-semctx-validation'
import { fixKind, type TicketSignals, ticketOfBranch } from './proof-ticket'
import { blob } from './proof-tree'

const CLOSING_ISSUES = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefName
      closingIssuesReferences(first: 25) {
        totalCount
        nodes { number title labels(first: 50) { totalCount nodes { name } } issueType { name } }
      }
    }
  }
}`

const NAMED_TICKET = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { number title labels(first: 50) { totalCount nodes { name } } issueType { name } }
  }
}`

function signalsOf(node: unknown): TicketSignals | null {
  if (!isMap(node) || typeof node.title !== 'string' || !isMap(node.labels) || !('issueType' in node)) return null
  const labels = node.labels.nodes
  if (!Array.isArray(labels) || node.labels.totalCount !== labels.length) return null
  const names = labels.map((label) => (isMap(label) && typeof label.name === 'string' ? label.name : null))
  const type = node.issueType
  const issueType = isMap(type) && typeof type.name === 'string' ? type.name : null
  if (names.includes(null) || (type !== null && issueType === null)) return null
  return { title: node.title, labels: names.filter((label) => label !== null), issueType }
}

type ClosingIssues = { branch: string; nodes: unknown[]; signals: TicketSignals[] }
type ExpectedRecord = { repository: string; pr: number; candidate: string; tree: string }
type NativeRecord = { manifest: string; replay: Step }
async function ticketQuery(cwd: string, gh: Gh, repository: string, query: string, number: number): Promise<string> {
  const [owner, name] = repository.split('/')
  return gh(cwd, [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-F',
    `number=${number}`,
  ])
}

async function configuredAdapters(facts: CandidateFacts, git: Git): Promise<string | Refusal> {
  for (const { at, entry } of facts.adapters) {
    let config: unknown
    try {
      config = JSON.parse(await blob(git, facts.toplevel, entry))
    } catch (error) {
      return refuse('assertledger', 'unreadable', `${ASSERTLEDGER_CONFIG} at ${at}: ${errorMessage(error)}`)
    }
    if (!isMap(config) || !isMap(config.adapter)) {
      return refuse('assertledger', 'ambiguous', `${ASSERTLEDGER_CONFIG} at ${at} declares no adapter`)
    }
  }
  return facts.adapters.map(({ at, entry }) => `${entry.path} at ${at}`).join(', ')
}

async function readClosingIssues(cwd: string, pr: number, gh: Gh, repository: string): Promise<ClosingIssues> {
  const raw = await ticketQuery(cwd, gh, repository, CLOSING_ISSUES, pr)
  const data = jsonField(raw, 'data')
  const repo = isMap(data) ? data.repository : undefined
  const pull = isMap(repo) ? repo.pullRequest : undefined
  const closing = isMap(pull) ? pull.closingIssuesReferences : undefined
  const nodes = isMap(closing) && Array.isArray(closing.nodes) ? closing.nodes : null
  const signals = nodes?.map(signalsOf) ?? []
  if (
    !isMap(pull) ||
    typeof pull.headRefName !== 'string' ||
    !isMap(closing) ||
    !nodes ||
    closing.totalCount !== nodes.length ||
    signals.includes(null)
  ) {
    throw new Error(`the closing issues of PR #${pr} could not be read — ${raw.slice(0, 200)}`)
  }
  return { branch: pull.headRefName, nodes, signals: signals.filter((signal) => signal !== null) }
}

async function readNamedTicket(
  cwd: string,
  gh: Gh,
  repository: string,
  number: number,
  branch: string,
): Promise<TicketSignals> {
  const raw = await ticketQuery(cwd, gh, repository, NAMED_TICKET, number)
  const data = jsonField(raw, 'data')
  const issue = isMap(data) && isMap(data.repository) ? signalsOf(data.repository.issue) : null
  if (!issue) {
    throw new Error(
      `issue #${number}, which branch ${JSON.stringify(branch)} names, could not be read — ${raw.slice(0, 200)}`,
    )
  }
  return issue
}

/** Whether the candidate's asserted adapters and ticket type require a detection. */
export async function assertledgerApplies(
  cwd: string,
  facts: CandidateFacts,
  target: Pick<Target, 'pr'>,
  deps: { gh: Gh; git: Git },
  repository: string,
): Promise<boolean | Refusal> {
  if (!facts.adapters.length) return false
  const adapter = await configuredAdapters(facts, deps.git)
  if (typeof adapter !== 'string') return adapter
  const closing = await readClosingIssues(cwd, target.pr, deps.gh, repository)
  const named = ticketOfBranch(closing.branch)
  if (named !== null && !closing.nodes.some((node) => isMap(node) && node.number === named)) {
    closing.signals.push(await readNamedTicket(cwd, deps.gh, repository, named, closing.branch))
  }
  const kind = fixKind(closing.branch, closing.signals)
  if (kind === 'unknown') {
    return refuse(
      'assertledger',
      'unreadable',
      `PR #${target.pr} (branch ${JSON.stringify(closing.branch)}, closing ${closing.nodes.length} issue(s)) establishes no ticket type: whether ${adapter} owes a detection is unknown — type the ticket or name the branch <type>/<N>-<slug>`,
    )
  }
  return kind === 'fix'
}

export type AssertledgerInvocation = {
  repository: string
  pr: number
  candidate: string
  manifest: string
  tool: { path: string; version: string }
}
export type AssertledgerRecord = {
  producer: 'assertledger'
  invocation: AssertledgerInvocation
  native: { manifest: string; replay: Step }
}

const REPLAY_FLAGS = ['valid', 'schemaValid', 'decisionDigestValid', 'artifactDigestValid', 'decisionSemanticsValid']
const GIT_REGRESSION = 'assertledger-git-regression/1'

function nativeRecord(record: unknown, expected: ExpectedRecord): NativeRecord | Refusal {
  if (!isMap(record) || record.producer !== 'assertledger' || !isMap(record.invocation) || !isMap(record.native)) {
    return refuse('assertledger', 'unreadable', 'the assertledger record has no producer/invocation/native parts')
  }
  for (const key of ['repository', 'pr', 'candidate'] as const) {
    if (record.invocation[key] !== expected[key]) {
      return refuse(
        'assertledger',
        'unbound',
        `the assertledger record does not bind: ${key} ${JSON.stringify(record.invocation[key])} ≠ ${JSON.stringify(expected[key])}`,
      )
    }
  }
  const { manifest, replay } = record.native
  if (
    typeof manifest !== 'string' ||
    !isStep(replay) ||
    replay.argv[0] !== 'replay' ||
    replay.argv.at(-1) !== '--json'
  ) {
    return refuse('assertledger', 'unreadable', 'the assertledger record carries no manifest and replay')
  }
  return { manifest, replay }
}

function parsedRecord(native: NativeRecord): { verdict: unknown; manifest: unknown } | Refusal {
  try {
    return { verdict: JSON.parse(native.replay.stdout), manifest: JSON.parse(native.manifest) }
  } catch {
    return refuse('assertledger', 'unreadable', 'the conserved manifest or its replay is not JSON')
  }
}

function replayVerdictIsValid(verdict: unknown): boolean {
  return isMap(verdict) && REPLAY_FLAGS.every((flag) => verdict[flag] === true)
}

function referenceProvenance(manifest: unknown): Record<string, unknown> | null {
  const context = isMap(manifest) && isMap(manifest.evidenceContext) ? manifest.evidenceContext : null
  const worlds = context && Array.isArray(context.worlds) ? context.worlds : []
  for (const world of worlds) {
    try {
      const provenance = isMap(world) && typeof world.provenance === 'string' ? JSON.parse(world.provenance) : null
      if (isMap(provenance) && provenance.format === GIT_REGRESSION && provenance.role === 'reference')
        return provenance
    } catch {}
  }
  return null
}

function detectionStatus(manifest: unknown): 'detection' | 'weak-oracle' | 'missing' {
  const decision = isMap(manifest) ? manifest.decision : undefined
  const candidates = isMap(manifest) && Array.isArray(manifest.candidates) ? manifest.candidates.filter(isMap) : []
  const selected = isMap(decision) && Array.isArray(decision.selectedCandidateIds) ? decision.selectedCandidateIds : []
  const eligible = selected.every((id) =>
    candidates.some((candidate) => candidate.id === id && candidate.status === 'ELIGIBLE'),
  )
  if (isMap(decision) && decision.status === 'VERIFIED' && selected.length && eligible) return 'detection'
  return candidates.some((candidate) => candidate.status === 'WEAK_ORACLE') ? 'weak-oracle' : 'missing'
}

/** Validates the replay, Git provenance, and detection verdict. */
export function readAssertledgerRecord(
  record: unknown,
  expected: { repository: string; pr: number; candidate: string; tree: string },
): 'detection' | Refusal {
  const native = nativeRecord(record, expected)
  if ('ok' in native) return native
  const parsed = parsedRecord(native)
  if ('ok' in parsed) return parsed
  if (native.replay.exit !== 0 || !replayVerdictIsValid(parsed.verdict)) {
    return refuse(
      'assertledger',
      'unreadable',
      `the manifest does not replay valid: ${native.replay.stdout.trim() || `exit ${native.replay.exit}`}`,
    )
  }
  const reference = referenceProvenance(parsed.manifest)
  if (!reference) {
    return refuse(
      'assertledger',
      'unbound',
      `the manifest's reference world carries no ${GIT_REGRESSION} provenance: its binding to ${expected.candidate} is unknown (a request-authored provenance such as the kit's "working tree of <short sha>" binds nothing) — produce a git-regression check manifest with --after ${expected.candidate}`,
    )
  }
  if (reference.commit !== expected.candidate || reference.tree !== expected.tree) {
    return refuse(
      'assertledger',
      'unbound',
      `the manifest's reference world is ${String(reference.commit)}, not candidate ${expected.candidate}`,
    )
  }
  const status = detectionStatus(parsed.manifest)
  if (status === 'detection') return status
  if (status === 'weak-oracle') {
    return refuse(
      'assertledger',
      'verdict',
      `assertledger reports WEAK_ORACLE for ${expected.candidate}: the test does not detect the fault`,
    )
  }
  const decision = isMap(parsed.manifest) ? parsed.manifest.decision : undefined
  return refuse(
    'assertledger',
    'verdict',
    `assertledger reports no detection for ${expected.candidate} (miss: ${isMap(decision) ? String(decision.status) : 'no decision'})`,
  )
}

export async function admitAssertledger(
  facts: CandidateFacts,
  target: Target,
  deps: Deps,
  read: Read,
  found: SelectedRecord,
): Promise<Refusal | null> {
  const args = ['rev-parse', `${target.candidate}^{tree}`]
  const tree = await deps.git(facts.toplevel, args)
  if (tree.code !== 0) return refuse('assertledger', 'unreadable', gitError(args, tree))
  const outcome = readAssertledgerRecord(found.record, {
    repository: read.repository,
    pr: target.pr,
    candidate: target.candidate,
    tree: oneLine(tree.stdout),
  })
  return outcome === 'detection' ? reviewedRecord(found.parts, target, 'assertledger') : outcome
}
