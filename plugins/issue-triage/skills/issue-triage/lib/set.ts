/**
 * Update an existing issue: labels, dependencies, and parent/child relations.
 * Replaces set.sh.
 */

import { GITHUB_REPO } from '../../shared/adapters/config-helpers'
import {
  addBlockedBy,
  addSubIssue,
  getNodeId,
  getParentNumber,
  removeBlockedBy,
  removeSubIssue,
  resolveIssueTypeId,
  updateIssueIssueType,
} from '../../shared/adapters/github-adapter'
import { requireFlagValue } from '../../shared/domain/cli-args'
import { EXTENDED_ISSUE_TYPES, ISSUE_TYPE_NAMES } from '../../shared/domain/issue-types'
import { formatRef, parseIssueRef, parseIssueRefs } from '../../shared/domain/parse-issue-ref'
import { type LabelFlags, resolveLabelFlags, writeLabels } from './label-flags'

interface SetOptions {
  issueNumber: number
  subjectRepo?: string
  size?: string
  priority?: string
  status?: string
  lane?: string
  type?: string
  blockedBy?: string
  blocks?: string
  rmBlockedBy?: string
  rmBlocks?: string
  parent?: string
  addChild?: string
  rmParent: boolean
  rmChild?: string
}

function parseArgs(args: string[]): SetOptions {
  const opts: SetOptions = { issueNumber: 0, rmParent: false }

  let i = 0
  while (i < args.length) {
    const arg = args[i]
    switch (arg) {
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
      case '--blocked-by':
        opts.blockedBy = requireFlagValue(args, ++i, '--blocked-by')
        break
      case '--blocks':
        opts.blocks = requireFlagValue(args, ++i, '--blocks')
        break
      case '--rm-blocked-by':
        opts.rmBlockedBy = requireFlagValue(args, ++i, '--rm-blocked-by')
        break
      case '--rm-blocks':
        opts.rmBlocks = requireFlagValue(args, ++i, '--rm-blocks')
        break
      case '--parent':
        opts.parent = requireFlagValue(args, ++i, '--parent')
        break
      case '--add-child':
        opts.addChild = requireFlagValue(args, ++i, '--add-child')
        break
      case '--rm-parent':
        opts.rmParent = true
        break
      case '--rm-child':
        opts.rmChild = requireFlagValue(args, ++i, '--rm-child')
        break
      default:
        if (!opts.issueNumber) {
          if (/^\d+$/.test(arg)) {
            opts.issueNumber = Number(arg)
          } else {
            const ref = parseIssueRef(arg)
            if (ref) {
              opts.issueNumber = ref.number
              opts.subjectRepo = ref.repo
            }
          }
        }
        break
    }
    i++
  }

  return opts
}

function subjectStr(issueNumber: number, repo?: string): string {
  return repo ? `${repo}#${issueNumber}` : `#${issueNumber}`
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

async function applyType(issueNumber: number, canonical: string): Promise<void> {
  const issueNodeId = await getNodeId(issueNumber)
  const org = GITHUB_REPO.split('/')[0]
  const typeId = await resolveIssueTypeId(org, canonical)
  await updateIssueIssueType(issueNodeId, typeId)
  console.log(`Type=${canonical} #${issueNumber}`)
}

async function applyDependencies(issueNumber: number, opts: SetOptions): Promise<void> {
  const subjStr = subjectStr(issueNumber, opts.subjectRepo)

  if (opts.blockedBy) {
    const issueNodeId = await getNodeId(issueNumber, opts.subjectRepo)
    for (const ref of parseIssueRefs(opts.blockedBy)) {
      const blockingNodeId = await getNodeId(ref.number, ref.repo)
      await addBlockedBy(issueNodeId, blockingNodeId)
      console.log(`BlockedBy=${formatRef(ref)} ${subjStr}`)
    }
  }

  if (opts.blocks) {
    const blockingNodeId = await getNodeId(issueNumber, opts.subjectRepo)
    for (const ref of parseIssueRefs(opts.blocks)) {
      const blockedNodeId = await getNodeId(ref.number, ref.repo)
      await addBlockedBy(blockedNodeId, blockingNodeId)
      console.log(`Blocks=${formatRef(ref)} ${subjStr}`)
    }
  }

  if (opts.rmBlockedBy) {
    const issueNodeId = await getNodeId(issueNumber, opts.subjectRepo)
    for (const ref of parseIssueRefs(opts.rmBlockedBy)) {
      const blockingNodeId = await getNodeId(ref.number, ref.repo)
      await removeBlockedBy(issueNodeId, blockingNodeId)
      console.log(`RemovedBlockedBy=${formatRef(ref)} ${subjStr}`)
    }
  }

  if (opts.rmBlocks) {
    const blockingNodeId = await getNodeId(issueNumber, opts.subjectRepo)
    for (const ref of parseIssueRefs(opts.rmBlocks)) {
      const blockedNodeId = await getNodeId(ref.number, ref.repo)
      await removeBlockedBy(blockedNodeId, blockingNodeId)
      console.log(`RemovedBlocks=${formatRef(ref)} ${subjStr}`)
    }
  }
}

async function applyParentChild(issueNumber: number, opts: SetOptions): Promise<void> {
  const subjStr = subjectStr(issueNumber, opts.subjectRepo)

  if (opts.parent) {
    const parentRef = parseIssueRefs(opts.parent)[0]
    if (parentRef) {
      const issueNodeId = await getNodeId(issueNumber, opts.subjectRepo)
      const parentNodeId = await getNodeId(parentRef.number, parentRef.repo)
      await addSubIssue(parentNodeId, issueNodeId)
      console.log(`Parent=${formatRef(parentRef)} ${subjStr}`)
    }
  }

  if (opts.addChild) {
    const issueNodeId = await getNodeId(issueNumber, opts.subjectRepo)
    for (const childRef of parseIssueRefs(opts.addChild)) {
      const childNodeId = await getNodeId(childRef.number, childRef.repo)
      await addSubIssue(issueNodeId, childNodeId)
      console.log(`Child=${formatRef(childRef)} ${subjStr}`)
    }
  }

  if (opts.rmParent) {
    if (opts.subjectRepo) {
      console.error(`Error: --rm-parent is not supported for cross-repo subjects (${subjStr}) — use direct GraphQL`)
      process.exit(1)
    }
    const parentNum = await getParentNumber(issueNumber)
    if (parentNum) {
      const issueNodeId = await getNodeId(issueNumber)
      const parentNodeId = await getNodeId(parentNum)
      await removeSubIssue(parentNodeId, issueNodeId)
      console.log(`RemovedParent=#${parentNum} ${subjStr}`)
    } else {
      console.log(`No parent found for ${subjStr}`)
    }
  }

  if (opts.rmChild) {
    const issueNodeId = await getNodeId(issueNumber, opts.subjectRepo)
    for (const childRef of parseIssueRefs(opts.rmChild)) {
      const childNodeId = await getNodeId(childRef.number, childRef.repo)
      await removeSubIssue(issueNodeId, childNodeId)
      console.log(`RemovedChild=${formatRef(childRef)} ${subjStr}`)
    }
  }
}

export async function setIssue(args: string[]): Promise<void> {
  const opts = parseArgs(args)

  if (!opts.issueNumber) {
    console.error('Error: Issue number required')
    process.exit(1)
  }

  const hasAction =
    opts.size ||
    opts.priority ||
    opts.status ||
    opts.lane ||
    opts.type ||
    opts.blockedBy ||
    opts.blocks ||
    opts.rmBlockedBy ||
    opts.rmBlocks ||
    opts.parent ||
    opts.addChild ||
    opts.rmParent ||
    opts.rmChild

  if (!hasAction) {
    console.error(
      'Error: Specify --size, --priority, --lane, --type, --blocked-by, --blocks, --rm-blocked-by, --rm-blocks, --parent, --add-child, --rm-parent, and/or --rm-child',
    )
    process.exit(1)
  }

  if (opts.status) {
    console.error('Error: --status is not supported in the issues-only model (open/closed).')
    process.exit(1)
  }

  // Canonicalise every flag before the first write: a rejected value must not
  // leave the issue half-updated — type applied, label refused, parent never
  // linked (PR #528 review).
  if (opts.type && opts.subjectRepo) {
    console.error(
      `Warning: --type is not supported for cross-repo subjects (${opts.subjectRepo}#${opts.issueNumber}) — skipped`,
    )
  }
  const type = opts.type && !opts.subjectRepo ? resolveType(opts.type) : undefined

  // Labels are skipped for cross-repo subjects.
  // Status is intentionally excluded: in the issues-only model status is just
  // open/closed and the dep-graph derives ready/blocked/done from edges, so a
  // `status:*` label is redundant (and noisy on repos that lack the label).
  const crossRepoLabels = Boolean(opts.subjectRepo && (opts.priority || opts.size || opts.lane))
  if (crossRepoLabels) {
    console.error(
      `Warning: --size/--priority/--lane label sync is not supported for cross-repo subjects (${opts.subjectRepo}#${opts.issueNumber}) — skipped`,
    )
  }
  const labels: LabelFlags = crossRepoLabels
    ? {}
    : resolveLabelFlags({ priority: opts.priority, size: opts.size, lane: opts.lane })

  if (type) await applyType(opts.issueNumber, type)
  const unwritten = await writeLabels(opts.issueNumber, labels)

  await applyDependencies(opts.issueNumber, opts)
  await applyParentChild(opts.issueNumber, opts)

  if (unwritten.length > 0) {
    console.error(`Error: label not written for ${unwritten.join(', ')} on #${opts.issueNumber}`)
    process.exit(1)
  }
}
