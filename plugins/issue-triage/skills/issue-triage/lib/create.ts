/**
 * Create a new GitHub issue with optional labels, parent, children, and dependencies.
 * Issues-only mode: size/priority/status/lane are set via labels only (no ProjectV2 board).
 */

import { GITHUB_REPO } from '../../shared/adapters/config-helpers'
import {
  addBlockedBy,
  addSubIssue,
  createGitHubIssue,
  getNodeId,
  resolveIssueTypeId,
  updateIssueIssueType,
} from '../../shared/adapters/github-adapter'
import { requireFlagValue } from '../../shared/domain/cli-args'
import { EXTENDED_ISSUE_TYPES, ISSUE_TYPE_NAMES } from '../../shared/domain/issue-types'
import { formatRef, parseIssueRefs } from '../../shared/domain/parse-issue-ref'
import { type LabelFlags, resolveLabelFlags, writeLabels } from './label-flags'

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
        opts.title = requireFlagValue(args, ++i, '--title')
        break
      case '--body':
        opts.body = requireFlagValue(args, ++i, '--body')
        break
      case '--label':
        opts.labels = requireFlagValue(args, ++i, '--label')
        break
      case '--size':
        opts.size = requireFlagValue(args, ++i, '--size')
        break
      case '--priority':
        opts.priority = requireFlagValue(args, ++i, '--priority')
        break
      case '--status':
        opts.status = requireFlagValue(args, ++i, '--status')
        break
      case '--lane':
        opts.lane = requireFlagValue(args, ++i, '--lane')
        break
      case '--type':
        opts.type = requireFlagValue(args, ++i, '--type')
        break
      case '--parent':
        opts.parent = requireFlagValue(args, ++i, '--parent')
        break
      case '--blocked-by':
        opts.blockedBy = requireFlagValue(args, ++i, '--blocked-by')
        break
      case '--blocks':
        opts.blocks = requireFlagValue(args, ++i, '--blocks')
        break
      case '--add-child':
        opts.addChild = requireFlagValue(args, ++i, '--add-child')
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

/** Canonicalise the type flag, rejecting an unknown one before any write. */
function resolveType(input: string): string {
  const canonical = input.toLowerCase()
  if (!VALID_TYPES.includes(canonical)) {
    console.error(`Error: Invalid type. Valid: ${VALID_TYPES.join(', ')}`)
    process.exit(1)
  }
  return canonical
}

async function applyType(issueNumber: number, nodeId: string, canonical: string): Promise<void> {
  const org = GITHUB_REPO.split('/')[0]
  const typeId = await resolveIssueTypeId(org, canonical)
  await updateIssueIssueType(nodeId, typeId)
  console.log(`Type=${canonical} #${issueNumber}`)
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

  // Canonicalise every flag ahead of createGitHubIssue: a rejected value must
  // not leave a created, half-triaged issue behind (#525).
  const type = opts.type ? resolveType(opts.type) : undefined
  const flags: LabelFlags = resolveLabelFlags({
    priority: opts.priority,
    size: opts.size,
    lane: opts.lane,
    status: opts.status,
  })

  const labels = opts.labels
    ?.split(',')
    .map((l) => l.trim())
    .filter(Boolean)
  const result = await createGitHubIssue(opts.title, opts.body, labels)
  const issueNumber = result.number
  console.log(`Created #${issueNumber}: ${opts.title}`)

  const nodeId = await getNodeId(issueNumber)

  if (type) await applyType(issueNumber, nodeId, type)

  // Labels only (issues-only mode). A label the repo does not carry must not
  // cancel the relationship writes queued behind it — collect, then fail last.
  const unwritten = await writeLabels(issueNumber, flags)

  await applyRelationships(nodeId, issueNumber, opts)

  if (unwritten.length > 0) {
    console.error(`Error: label not written for ${unwritten.join(', ')} on #${issueNumber}`)
    process.exit(1)
  }
}
