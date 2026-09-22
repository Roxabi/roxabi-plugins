/**
 * Create a new GitHub issue with optional labels, parent, children, and dependencies.
 * Issues-only mode: size/priority/status/lane are set via labels only (no ProjectV2 board).
 */

import {
  DEFAULT_LANE_OPTIONS,
  DEFAULT_SIZE_OPTIONS,
  DEFAULT_STATUS_OPTIONS,
  GITHUB_REPO,
  PRIORITY_INPUT_HINT,
  resolveLane,
  resolvePriority,
  resolveSize,
  resolveStatus,
} from '../../shared/adapters/config-helpers'
import {
  addBlockedBy,
  addSubIssue,
  createGitHubIssue,
  getNodeId,
  resolveIssueTypeId,
  updateIssueIssueType,
} from '../../shared/adapters/github-adapter'
import { syncLaneLabel, syncPriorityLabel, syncSizeLabel, syncStatusLabel } from '../../shared/adapters/github-infra'
import { EXTENDED_ISSUE_TYPES, ISSUE_TYPE_NAMES } from '../../shared/domain/issue-types'
import { formatRef, parseIssueRefs } from '../../shared/domain/parse-issue-ref'

interface CreateOptions {
  title: string
  body?: string
  labels?: string
  size?: string
  priority?: string
  status?: string
  lane?: string
  type?: string
  parent?: string
  blockedBy?: string
  blocks?: string
  addChild?: string
}

function parseArgs(args: string[]): CreateOptions {
  const opts: CreateOptions = { title: '' }

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    switch (arg) {
      case '--title':
        opts.title = args[++i]
        break
      case '--body':
        opts.body = args[++i]
        break
      case '--label':
        opts.labels = args[++i]
        break
      case '--size':
        opts.size = args[++i]
        break
      case '--priority':
        opts.priority = args[++i]
        break
      case '--status':
        opts.status = args[++i]
        break
      case '--lane':
        opts.lane = args[++i]
        break
      case '--type':
        opts.type = args[++i]
        break
      case '--parent':
        opts.parent = args[++i]
        break
      case '--blocked-by':
        opts.blockedBy = args[++i]
        break
      case '--blocks':
        opts.blocks = args[++i]
        break
      case '--add-child':
        opts.addChild = args[++i]
        break
      default:
        console.error(`Error: Unknown option '${arg}'`)
        process.exit(1)
    }
    i++
  }

  return opts
}

const VALID_TYPES: string[] = [...ISSUE_TYPE_NAMES, ...EXTENDED_ISSUE_TYPES]

async function applyType(issueNumber: number, nodeId: string, type: string): Promise<void> {
  const canonical = type.toLowerCase()
  if (!VALID_TYPES.includes(canonical)) {
    console.error(`Error: Invalid type. Valid: ${VALID_TYPES.join(', ')}`)
    process.exit(1)
  }
  const org = GITHUB_REPO.split('/')[0]
  const typeId = await resolveIssueTypeId(org, canonical)
  await updateIssueIssueType(nodeId, typeId)
  console.log(`Type=${canonical} #${issueNumber}`)
}

interface ResolvedLabels {
  priority?: string
  size?: string
  lane?: string
  status?: string
}

/**
 * Canonicalise every label flag, rejecting unrecognised values loudly.
 *
 * Runs with the --type pre-check, ahead of createGitHubIssue: a bad value must
 * neither pass for a successful write nor leave a created, half-triaged issue
 * behind (#525).
 */
function resolveLabelFlags(opts: CreateOptions): ResolvedLabels {
  const resolved: ResolvedLabels = {}
  if (opts.priority) {
    resolved.priority = resolvePriority(opts.priority)
    if (!resolved.priority) {
      console.error(`Error: Invalid priority '${opts.priority}'. Valid: ${PRIORITY_INPUT_HINT}`)
      process.exit(1)
    }
  }
  if (opts.size) {
    resolved.size = resolveSize(opts.size)
    if (!resolved.size) {
      console.error(`Error: Invalid size '${opts.size}'. Valid: ${DEFAULT_SIZE_OPTIONS.join(', ')}`)
      process.exit(1)
    }
  }
  if (opts.lane) {
    resolved.lane = resolveLane(opts.lane)
    if (!resolved.lane) {
      console.error(`Error: Invalid lane '${opts.lane}'. Valid: ${DEFAULT_LANE_OPTIONS.join(', ')}`)
      process.exit(1)
    }
  }
  if (opts.status) {
    resolved.status = resolveStatus(opts.status)
    if (!resolved.status) {
      console.error(`Error: Invalid status '${opts.status}'. Valid: ${DEFAULT_STATUS_OPTIONS.join(', ')}`)
      process.exit(1)
    }
  }
  return resolved
}

/** Write the canonical labels, echoing each one — every write is reported. */
async function syncLabels(issueNumber: number, resolved: ResolvedLabels): Promise<void> {
  if (resolved.priority) {
    const ok = await syncPriorityLabel(issueNumber, resolved.priority)
    if (!ok) process.exit(1)
    console.log(`Priority=${resolved.priority} #${issueNumber}`)
  }
  if (resolved.size) {
    const ok = await syncSizeLabel(issueNumber, resolved.size)
    if (!ok) process.exit(1)
    console.log(`Size=${resolved.size} #${issueNumber}`)
  }
  if (resolved.lane) {
    const ok = await syncLaneLabel(issueNumber, resolved.lane)
    if (!ok) process.exit(1)
    console.log(`Lane=${resolved.lane} #${issueNumber}`)
  }
  if (resolved.status) {
    const ok = await syncStatusLabel(issueNumber, resolved.status)
    if (!ok) process.exit(1)
    console.log(`Status=${resolved.status} #${issueNumber}`)
  }
}

async function applyRelationships(nodeId: string, issueNumber: number, opts: CreateOptions): Promise<void> {
  if (opts.parent) {
    const parentRef = parseIssueRefs(opts.parent)[0]
    if (parentRef) {
      const parentNodeId = await getNodeId(parentRef.number, parentRef.repo)
      await addSubIssue(parentNodeId, nodeId)
      console.log(`Parent=${formatRef(parentRef)} #${issueNumber}`)
    }
  }

  if (opts.addChild) {
    for (const childRef of parseIssueRefs(opts.addChild)) {
      const childNodeId = await getNodeId(childRef.number, childRef.repo)
      await addSubIssue(nodeId, childNodeId)
      console.log(`Child=${formatRef(childRef)} #${issueNumber}`)
    }
  }

  if (opts.blockedBy) {
    for (const ref of parseIssueRefs(opts.blockedBy)) {
      const blockingNodeId = await getNodeId(ref.number, ref.repo)
      await addBlockedBy(nodeId, blockingNodeId)
      console.log(`BlockedBy=${formatRef(ref)} #${issueNumber}`)
    }
  }

  if (opts.blocks) {
    for (const ref of parseIssueRefs(opts.blocks)) {
      const blockedNodeId = await getNodeId(ref.number, ref.repo)
      await addBlockedBy(blockedNodeId, nodeId)
      console.log(`Blocks=${formatRef(ref)} #${issueNumber}`)
    }
  }
}

export async function createIssue(args: string[]): Promise<void> {
  const opts = parseArgs(args)

  if (!opts.title) {
    console.error('Error: --title is required')
    process.exit(1)
  }

  if (opts.type) {
    const canonical = opts.type.toLowerCase()
    if (!VALID_TYPES.includes(canonical)) {
      console.error(`Error: Invalid type. Valid: ${VALID_TYPES.join(', ')}`)
      process.exit(1)
    }
  }

  const resolved = resolveLabelFlags(opts)

  const labels = opts.labels
    ?.split(',')
    .map((l) => l.trim())
    .filter(Boolean)
  const result = await createGitHubIssue(opts.title, opts.body, labels)
  const issueNumber = result.number
  console.log(`Created #${issueNumber}: ${opts.title}`)

  const nodeId = await getNodeId(issueNumber)

  if (opts.type) {
    await applyType(issueNumber, nodeId, opts.type)
  }

  // Set size/priority/status/lane via labels only (issues-only mode)
  await syncLabels(issueNumber, resolved)

  await applyRelationships(nodeId, issueNumber, opts)
}
