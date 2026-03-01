/**
 * Update an existing issue: project fields, dependencies, and parent/child relations.
 * Replaces set.sh.
 */

import {
  NOT_CONFIGURED_MSG,
  PRIORITY_FIELD_ID,
  PRIORITY_OPTIONS,
  isProjectConfigured,
  resolvePriority,
  resolveSize,
  resolveStatus,
  SIZE_FIELD_ID,
  SIZE_OPTIONS,
  STATUS_FIELD_ID,
  STATUS_OPTIONS,
} from '../../shared/config'
import {
  addBlockedBy,
  addSubIssue,
  getItemId,
  getNodeId,
  getParentNumber,
  removeBlockedBy,
  removeSubIssue,
  updateField,
} from '../../shared/github'

interface SetOptions {
  issueNumber: number
  size?: string
  priority?: string
  status?: string
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
        opts.size = args[++i]
        break
      case '--priority':
        opts.priority = args[++i]
        break
      case '--status':
        opts.status = args[++i]
        break
      case '--blocked-by':
        opts.blockedBy = args[++i]
        break
      case '--blocks':
        opts.blocks = args[++i]
        break
      case '--rm-blocked-by':
        opts.rmBlockedBy = args[++i]
        break
      case '--rm-blocks':
        opts.rmBlocks = args[++i]
        break
      case '--parent':
        opts.parent = args[++i]
        break
      case '--add-child':
        opts.addChild = args[++i]
        break
      case '--rm-parent':
        opts.rmParent = true
        break
      case '--rm-child':
        opts.rmChild = args[++i]
        break
      default:
        if (!opts.issueNumber && /^\d+$/.test(arg)) {
          opts.issueNumber = Number(arg)
        }
        break
    }
    i++
  }

  return opts
}

function parseNumberList(input: string): number[] {
  return input
    .split(',')
    .map((s) => s.trim().replace(/^#/, ''))
    .filter(Boolean)
    .map(Number)
}

function resolveItemId(issueNumber: number): Promise<string | undefined> {
  return getItemId(issueNumber).catch(() => {
    console.error(
      `Warning: Issue #${issueNumber} not found in project — skipping project field updates (status/size/priority)`
    )
    return
  })
}

async function applyStatus(itemId: string, issueNumber: number, status: string): Promise<void> {
  const canonical = resolveStatus(status)
  if (!(canonical && STATUS_OPTIONS[canonical])) {
    console.error(
      'Error: Invalid status. Valid: Backlog, Analysis, Specs, "In Progress", Review, Done'
    )
    process.exit(1)
  }
  await updateField(itemId, STATUS_FIELD_ID, STATUS_OPTIONS[canonical])
  console.log(`Status=${canonical} #${issueNumber}`)
}

async function applySize(itemId: string, issueNumber: number, size: string): Promise<void> {
  const canonical = resolveSize(size)
  if (!(canonical && SIZE_OPTIONS[canonical])) {
    console.error(`Error: Invalid size. Valid: ${Object.keys(SIZE_OPTIONS).join(', ')}`)
    process.exit(1)
  }
  await updateField(itemId, SIZE_FIELD_ID, SIZE_OPTIONS[canonical])
  console.log(`Size=${canonical} #${issueNumber}`)
}

async function applyPriority(itemId: string, issueNumber: number, priority: string): Promise<void> {
  const canonical = resolvePriority(priority)
  if (!(canonical && PRIORITY_OPTIONS[canonical])) {
    console.error('Error: Invalid priority. Valid: Urgent, High, Medium, Low')
    process.exit(1)
  }
  await updateField(itemId, PRIORITY_FIELD_ID, PRIORITY_OPTIONS[canonical])
  console.log(`Priority=${canonical} #${issueNumber}`)
}

async function applyProjectFields(issueNumber: number, opts: SetOptions): Promise<void> {
  if (!(opts.size || opts.priority || opts.status)) return

  if (!isProjectConfigured()) {
    console.error(NOT_CONFIGURED_MSG)
    process.exit(1)
  }

  const itemId = await resolveItemId(issueNumber)
  if (!itemId) return

  if (opts.status) await applyStatus(itemId, issueNumber, opts.status)
  if (opts.size) await applySize(itemId, issueNumber, opts.size)
  if (opts.priority) await applyPriority(itemId, issueNumber, opts.priority)
}

async function applyDependencies(issueNumber: number, opts: SetOptions): Promise<void> {
  if (opts.blockedBy) {
    const issueNodeId = await getNodeId(issueNumber)
    for (const dep of parseNumberList(opts.blockedBy)) {
      const blockingNodeId = await getNodeId(dep)
      await addBlockedBy(issueNodeId, blockingNodeId)
      console.log(`BlockedBy=#${dep} #${issueNumber}`)
    }
  }

  if (opts.blocks) {
    const blockingNodeId = await getNodeId(issueNumber)
    for (const dep of parseNumberList(opts.blocks)) {
      const blockedNodeId = await getNodeId(dep)
      await addBlockedBy(blockedNodeId, blockingNodeId)
      console.log(`Blocks=#${dep} #${issueNumber}`)
    }
  }

  if (opts.rmBlockedBy) {
    const issueNodeId = await getNodeId(issueNumber)
    for (const dep of parseNumberList(opts.rmBlockedBy)) {
      const blockingNodeId = await getNodeId(dep)
      await removeBlockedBy(issueNodeId, blockingNodeId)
      console.log(`RemovedBlockedBy=#${dep} #${issueNumber}`)
    }
  }

  if (opts.rmBlocks) {
    const blockingNodeId = await getNodeId(issueNumber)
    for (const dep of parseNumberList(opts.rmBlocks)) {
      const blockedNodeId = await getNodeId(dep)
      await removeBlockedBy(blockedNodeId, blockingNodeId)
      console.log(`RemovedBlocks=#${dep} #${issueNumber}`)
    }
  }
}

async function applyParentChild(issueNumber: number, opts: SetOptions): Promise<void> {
  if (opts.parent) {
    const parentNum = opts.parent.replace(/^#/, '')
    const issueNodeId = await getNodeId(issueNumber)
    const parentNodeId = await getNodeId(parentNum)
    await addSubIssue(parentNodeId, issueNodeId)
    console.log(`Parent=#${parentNum} #${issueNumber}`)
  }

  if (opts.addChild) {
    const issueNodeId = await getNodeId(issueNumber)
    for (const child of parseNumberList(opts.addChild)) {
      const childNodeId = await getNodeId(child)
      await addSubIssue(issueNodeId, childNodeId)
      console.log(`Child=#${child} #${issueNumber}`)
    }
  }

  if (opts.rmParent) {
    const parentNum = await getParentNumber(issueNumber)
    if (parentNum) {
      const issueNodeId = await getNodeId(issueNumber)
      const parentNodeId = await getNodeId(parentNum)
      await removeSubIssue(parentNodeId, issueNodeId)
      console.log(`RemovedParent=#${parentNum} #${issueNumber}`)
    } else {
      console.log(`No parent found for #${issueNumber}`)
    }
  }

  if (opts.rmChild) {
    const issueNodeId = await getNodeId(issueNumber)
    for (const child of parseNumberList(opts.rmChild)) {
      const childNodeId = await getNodeId(child)
      await removeSubIssue(issueNodeId, childNodeId)
      console.log(`RemovedChild=#${child} #${issueNumber}`)
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
      'Error: Specify --size, --priority, --status, --blocked-by, --blocks, --rm-blocked-by, --rm-blocks, --parent, --add-child, --rm-parent, and/or --rm-child'
    )
    process.exit(1)
  }

  await applyProjectFields(opts.issueNumber, opts)
  await applyDependencies(opts.issueNumber, opts)
  await applyParentChild(opts.issueNumber, opts)
}
