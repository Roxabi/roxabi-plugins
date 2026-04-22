/**
 * Update an existing issue: project fields, dependencies, and parent/child relations.
 * Replaces set.sh.
 */

import {
  GITHUB_REPO,
  isProjectConfigured,
  LANE_FIELD_ID,
  LANE_OPTIONS,
  NOT_CONFIGURED_MSG,
  PRIORITY_FIELD_ID,
  PRIORITY_OPTIONS,
  resolveLane,
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
  getItemId,
  getNodeId,
  getParentNumber,
  removeBlockedBy,
  removeSubIssue,
  resolveIssueTypeId,
  updateField,
  updateIssueIssueType,
} from '../../shared/adapters/github-adapter'
import { syncPriorityLabel } from '../../shared/adapters/github-infra'
import { parseIssueRefs } from '../../shared/domain/parse-issue-ref'

interface SetOptions {
  issueNumber: number
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

function resolveItemId(issueNumber: number): Promise<string | undefined> {
  return getItemId(issueNumber).catch(() => {
    console.error(
      `Warning: Issue #${issueNumber} not found in project — skipping project field updates (status/size/priority)`,
    )
    return undefined
  })
}

async function applyStatus(itemId: string, issueNumber: number, status: string): Promise<void> {
  const canonical = resolveStatus(status)
  if (!(canonical && STATUS_OPTIONS[canonical])) {
    console.error('Error: Invalid status. Valid: Backlog, Analysis, Specs, "In Progress", Review, Done')
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

async function applyLane(itemId: string, issueNumber: number, lane: string): Promise<void> {
  const canonical = resolveLane(lane)
  if (!(canonical && LANE_OPTIONS[canonical])) {
    console.error(`Error: Invalid lane. Valid: ${Object.keys(LANE_OPTIONS).join(', ')}`)
    process.exit(1)
  }
  await updateField(itemId, LANE_FIELD_ID, LANE_OPTIONS[canonical])
  console.log(`Lane=${canonical} #${issueNumber}`)
}

const VALID_TYPES = ['fix', 'feat', 'docs', 'test', 'chore', 'ci', 'perf', 'epic', 'research', 'refactor']

async function applyType(issueNumber: number, type: string): Promise<void> {
  const canonical = type.toLowerCase()
  if (!VALID_TYPES.includes(canonical)) {
    console.error(`Error: Invalid type. Valid: ${VALID_TYPES.join(', ')}`)
    process.exit(1)
  }
  const issueNodeId = await getNodeId(issueNumber)
  const org = GITHUB_REPO.split('/')[0]
  const typeId = await resolveIssueTypeId(org, canonical)
  await updateIssueIssueType(issueNodeId, typeId)
  console.log(`Type=${canonical} #${issueNumber}`)
}

async function applyProjectFields(issueNumber: number, opts: SetOptions): Promise<void> {
  if (!(opts.size || opts.priority || opts.status || opts.lane || opts.type)) return

  if (!isProjectConfigured()) {
    console.error(NOT_CONFIGURED_MSG)
    process.exit(1)
  }

  const itemId = await resolveItemId(issueNumber)
  if (!itemId) return

  if (opts.status) await applyStatus(itemId, issueNumber, opts.status)
  if (opts.size) await applySize(itemId, issueNumber, opts.size)
  if (opts.priority) await applyPriority(itemId, issueNumber, opts.priority)
  if (opts.lane) await applyLane(itemId, issueNumber, opts.lane)
  if (opts.type) await applyType(issueNumber, opts.type)
}

async function applyDependencies(issueNumber: number, opts: SetOptions): Promise<void> {
  if (opts.blockedBy) {
    const issueNodeId = await getNodeId(issueNumber)
    for (const ref of parseIssueRefs(opts.blockedBy)) {
      const blockingNodeId = await getNodeId(ref.number, ref.repo)
      await addBlockedBy(issueNodeId, blockingNodeId)
      const refStr = ref.repo ? `${ref.repo}#${ref.number}` : `#${ref.number}`
      console.log(`BlockedBy=${refStr} #${issueNumber}`)
    }
  }

  if (opts.blocks) {
    const blockingNodeId = await getNodeId(issueNumber)
    for (const ref of parseIssueRefs(opts.blocks)) {
      const blockedNodeId = await getNodeId(ref.number, ref.repo)
      await addBlockedBy(blockedNodeId, blockingNodeId)
      const refStr = ref.repo ? `${ref.repo}#${ref.number}` : `#${ref.number}`
      console.log(`Blocks=${refStr} #${issueNumber}`)
    }
  }

  if (opts.rmBlockedBy) {
    const issueNodeId = await getNodeId(issueNumber)
    for (const ref of parseIssueRefs(opts.rmBlockedBy)) {
      const blockingNodeId = await getNodeId(ref.number, ref.repo)
      await removeBlockedBy(issueNodeId, blockingNodeId)
      const refStr = ref.repo ? `${ref.repo}#${ref.number}` : `#${ref.number}`
      console.log(`RemovedBlockedBy=${refStr} #${issueNumber}`)
    }
  }

  if (opts.rmBlocks) {
    const blockingNodeId = await getNodeId(issueNumber)
    for (const ref of parseIssueRefs(opts.rmBlocks)) {
      const blockedNodeId = await getNodeId(ref.number, ref.repo)
      await removeBlockedBy(blockedNodeId, blockingNodeId)
      const refStr = ref.repo ? `${ref.repo}#${ref.number}` : `#${ref.number}`
      console.log(`RemovedBlocks=${refStr} #${issueNumber}`)
    }
  }
}

async function applyParentChild(issueNumber: number, opts: SetOptions): Promise<void> {
  if (opts.parent) {
    const parentRef = parseIssueRefs(opts.parent)[0]
    if (parentRef) {
      const issueNodeId = await getNodeId(issueNumber)
      const parentNodeId = await getNodeId(parentRef.number, parentRef.repo)
      await addSubIssue(parentNodeId, issueNodeId)
      const refStr = parentRef.repo ? `${parentRef.repo}#${parentRef.number}` : `#${parentRef.number}`
      console.log(`Parent=${refStr} #${issueNumber}`)
    }
  }

  if (opts.addChild) {
    const issueNodeId = await getNodeId(issueNumber)
    for (const childRef of parseIssueRefs(opts.addChild)) {
      const childNodeId = await getNodeId(childRef.number, childRef.repo)
      await addSubIssue(issueNodeId, childNodeId)
      const refStr = childRef.repo ? `${childRef.repo}#${childRef.number}` : `#${childRef.number}`
      console.log(`Child=${refStr} #${issueNumber}`)
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
    for (const childRef of parseIssueRefs(opts.rmChild)) {
      const childNodeId = await getNodeId(childRef.number, childRef.repo)
      await removeSubIssue(issueNodeId, childNodeId)
      const refStr = childRef.repo ? `${childRef.repo}#${childRef.number}` : `#${childRef.number}`
      console.log(`RemovedChild=${refStr} #${issueNumber}`)
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
      'Error: Specify --size, --priority, --status, --lane, --type, --blocked-by, --blocks, --rm-blocked-by, --rm-blocks, --parent, --add-child, --rm-parent, and/or --rm-child',
    )
    process.exit(1)
  }

  await applyProjectFields(opts.issueNumber, opts)

  // Sync priority label (independent of project board)
  if (opts.priority) {
    const canonical = resolvePriority(opts.priority)
    if (canonical) await syncPriorityLabel(opts.issueNumber, canonical)
  }

  await applyDependencies(opts.issueNumber, opts)
  await applyParentChild(opts.issueNumber, opts)
}
