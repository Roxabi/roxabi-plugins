/**
 * Create a new GitHub issue with optional project fields, parent, children, and dependencies.
 * Replaces create.sh.
 */

import {
  isProjectConfigured,
  NOT_CONFIGURED_MSG,
  PRIORITY_FIELD_ID,
  PRIORITY_OPTIONS,
  resolvePriority,
  resolveSize,
  resolveStatus,
  SIZE_FIELD_ID,
  SIZE_OPTIONS,
  STATUS_FIELD_ID,
  STATUS_OPTIONS,
} from '../../shared/adapters/config-helpers'
import {
  addBlockedBy,
  addSubIssue,
  addToProject,
  createGitHubIssue,
  getNodeId,
  updateField,
} from '../../shared/adapters/github-adapter'
import { syncPriorityLabel } from '../../shared/adapters/github-infra'
import { parseIssueRefs } from '../../shared/domain/parse-issue-ref'

interface CreateOptions {
  title: string
  body?: string
  labels?: string
  size?: string
  priority?: string
  status?: string
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

async function applyProjectFields(itemId: string, issueNumber: number, opts: CreateOptions): Promise<void> {
  if (opts.status) {
    const canonical = resolveStatus(opts.status)
    if (!(canonical && STATUS_OPTIONS[canonical])) {
      console.error('Error: Invalid status')
      process.exit(1)
    }
    await updateField(itemId, STATUS_FIELD_ID, STATUS_OPTIONS[canonical])
    console.log(`Status=${canonical} #${issueNumber}`)
  }

  if (opts.size) {
    const canonical = resolveSize(opts.size)
    if (!(canonical && SIZE_OPTIONS[canonical])) {
      console.error('Error: Invalid size')
      process.exit(1)
    }
    await updateField(itemId, SIZE_FIELD_ID, SIZE_OPTIONS[canonical])
    console.log(`Size=${canonical} #${issueNumber}`)
  }

  if (opts.priority) {
    const canonical = resolvePriority(opts.priority)
    if (!(canonical && PRIORITY_OPTIONS[canonical])) {
      console.error('Error: Invalid priority')
      process.exit(1)
    }
    await updateField(itemId, PRIORITY_FIELD_ID, PRIORITY_OPTIONS[canonical])
    console.log(`Priority=${canonical} #${issueNumber}`)
  }
}

async function applyRelationships(nodeId: string, issueNumber: number, opts: CreateOptions): Promise<void> {
  if (opts.parent) {
    const parentRef = parseIssueRefs(opts.parent)[0]
    if (parentRef) {
      const parentNodeId = await getNodeId(parentRef.number, parentRef.repo)
      await addSubIssue(parentNodeId, nodeId)
      const refStr = parentRef.repo ? `${parentRef.repo}#${parentRef.number}` : `#${parentRef.number}`
      console.log(`Parent=${refStr} #${issueNumber}`)
    }
  }

  if (opts.addChild) {
    for (const childRef of parseIssueRefs(opts.addChild)) {
      const childNodeId = await getNodeId(childRef.number, childRef.repo)
      await addSubIssue(nodeId, childNodeId)
      const refStr = childRef.repo ? `${childRef.repo}#${childRef.number}` : `#${childRef.number}`
      console.log(`Child=${refStr} #${issueNumber}`)
    }
  }

  if (opts.blockedBy) {
    for (const ref of parseIssueRefs(opts.blockedBy)) {
      const blockingNodeId = await getNodeId(ref.number, ref.repo)
      await addBlockedBy(nodeId, blockingNodeId)
      const refStr = ref.repo ? `${ref.repo}#${ref.number}` : `#${ref.number}`
      console.log(`BlockedBy=${refStr} #${issueNumber}`)
    }
  }

  if (opts.blocks) {
    for (const ref of parseIssueRefs(opts.blocks)) {
      const blockedNodeId = await getNodeId(ref.number, ref.repo)
      await addBlockedBy(blockedNodeId, nodeId)
      const refStr = ref.repo ? `${ref.repo}#${ref.number}` : `#${ref.number}`
      console.log(`Blocks=${refStr} #${issueNumber}`)
    }
  }
}

export async function createIssue(args: string[]): Promise<void> {
  const opts = parseArgs(args)

  if (!opts.title) {
    console.error('Error: --title is required')
    process.exit(1)
  }

  // Create the issue via REST API
  const labels = opts.labels
    ?.split(',')
    .map((l) => l.trim())
    .filter(Boolean)
  const result = await createGitHubIssue(opts.title, opts.body, labels)
  const issueNumber = result.number
  console.log(`Created #${issueNumber}: ${opts.title}`)

  const nodeId = await getNodeId(issueNumber)
  const wantsProjectFields = !!(opts.status || opts.size || opts.priority)

  // Add to project board (non-fatal, skip if not configured)
  let itemId: string | undefined
  if (isProjectConfigured()) {
    try {
      itemId = await addToProject(nodeId)
      console.log(`Added #${issueNumber} to project`)
    } catch {
      console.error(`Warning: Failed to add #${issueNumber} to project board — skipping project field updates`)
    }

    // Set project fields (require a valid item_id from addToProject)
    if (itemId) {
      await applyProjectFields(itemId, issueNumber, opts)
    } else if (wantsProjectFields) {
      console.error('Warning: Skipped project field updates (status/size/priority) — issue not on project board')
    }
  } else if (wantsProjectFields) {
    console.error(NOT_CONFIGURED_MSG)
  }

  // Sync priority label (independent of project board)
  if (opts.priority) {
    const canonical = resolvePriority(opts.priority)
    if (canonical) await syncPriorityLabel(issueNumber, canonical)
  }

  await applyRelationships(nodeId, issueNumber, opts)
}
