/**
 * Update an existing issue: labels, dependencies, parent/child, and body.
 * Replaces set.sh.
 *
 * Every flag is canonicalised, and every lookup that can reject the command is
 * resolved, before the first GitHub mutation. The body PATCH is the last write.
 * A rejected PATCH does not roll back label or relation writes that already landed.
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
  updateIssueBody,
  updateIssueIssueType,
} from '../../shared/adapters/github-adapter'
import { readFlagFile, requireFlagValue } from '../../shared/domain/cli-args'
import { EXTENDED_ISSUE_TYPES, ISSUE_TYPE_NAMES } from '../../shared/domain/issue-types'
import { formatRef, parseIssueRef } from '../../shared/domain/parse-issue-ref'
import type { ParsedIssueRef } from '../../shared/domain/types'
import { type LabelFlags, resolveLabelFlags, writeLabels } from './label-flags'

const SET_FLAGS: Record<string, true> = {
  '--size': true,
  '--priority': true,
  '--status': true,
  '--lane': true,
  '--type': true,
  '--blocked-by': true,
  '--blocks': true,
  '--rm-blocked-by': true,
  '--rm-blocks': true,
  '--parent': true,
  '--add-child': true,
  '--rm-parent': true,
  '--rm-child': true,
  '--body': true,
  '--body-file': true,
  '--clear-body': true,
}

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
  body?: string
  bodySet: boolean
  clearBody: boolean
}

interface BoundRef {
  ref: ParsedIssueRef
  nodeId: string
}

interface ResolvedWrites {
  subjectNodeId?: string
  typeId?: string
  blockedBy: BoundRef[]
  blocks: BoundRef[]
  rmBlockedBy: BoundRef[]
  rmBlocks: BoundRef[]
  parent?: BoundRef
  children: BoundRef[]
  rmChildren: BoundRef[]
  removedParent?: { parentNum: number; parentNodeId: string }
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function parseArgs(args: string[]): SetOptions {
  const opts: SetOptions = { issueNumber: 0, rmParent: false, bodySet: false, clearBody: false }

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
      case '--body': {
        const value = requireFlagValue(args, ++i, '--body')
        if (value in SET_FLAGS) {
          fail(`Error: --body value looks like a flag (${value}); pass body text via --body-file`)
        }
        opts.body = value
        opts.bodySet = true
        break
      }
      case '--body-file': {
        const path = args[i + 1]
        if (path !== undefined && path in SET_FLAGS) {
          fail(`Error: --body-file value looks like a flag (${path})`)
        }
        opts.body = readFlagFile(args, ++i, '--body-file')
        opts.bodySet = true
        break
      }
      case '--clear-body':
        opts.clearBody = true
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

function refuseBody(opts: SetOptions): void {
  if (opts.clearBody && opts.bodySet) {
    fail('Error: --clear-body cannot be combined with --body or --body-file')
  }
  if (opts.clearBody) {
    opts.body = ''
    return
  }
  if (opts.bodySet && (opts.body ?? '').trim() === '') {
    fail('Error: refusing an empty or whitespace-only body; use --clear-body to clear')
  }
}

const VALID_TYPES: string[] = [...ISSUE_TYPE_NAMES, ...EXTENDED_ISSUE_TYPES]

/** Canonicalise the type flag, rejecting an unknown one before any write. */
function resolveType(input: string): string {
  const canonical = input.toLowerCase()
  if (!VALID_TYPES.includes(canonical)) {
    fail(`Error: Invalid type. Valid: ${VALID_TYPES.join(', ')}`)
  }
  return canonical
}

/**
 * Parse every relation token here. Shared `parseIssueRefs` warn-and-skips, which
 * would let a body PATCH land after a bad ref. `create` keeps that skip.
 */
function requireRefs(input: string, flag: string): ParsedIssueRef[] {
  const refs: ParsedIssueRef[] = []
  for (const part of input.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const ref = parseIssueRef(trimmed)
    if (!ref) fail(`Error: Invalid issue reference "${trimmed}" for ${flag}`)
    refs.push(ref)
  }
  if (refs.length === 0) fail(`Error: ${flag} did not resolve to an issue reference`)
  return refs
}

async function lookup<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    fail(`Error: ${(error as Error).message}`)
  }
}

async function bindRefs(refs: ParsedIssueRef[]): Promise<BoundRef[]> {
  const bound: BoundRef[] = []
  for (const ref of refs) {
    bound.push({ ref, nodeId: await lookup(() => getNodeId(ref.number, ref.repo)) })
  }
  return bound
}

async function resolveWrites(issueNumber: number, opts: SetOptions, type: string | undefined): Promise<ResolvedWrites> {
  const blockedBy = opts.blockedBy ? requireRefs(opts.blockedBy, '--blocked-by') : []
  const blocks = opts.blocks ? requireRefs(opts.blocks, '--blocks') : []
  const rmBlockedBy = opts.rmBlockedBy ? requireRefs(opts.rmBlockedBy, '--rm-blocked-by') : []
  const rmBlocks = opts.rmBlocks ? requireRefs(opts.rmBlocks, '--rm-blocks') : []
  const parent = opts.parent ? requireRefs(opts.parent, '--parent')[0] : undefined
  const children = opts.addChild ? requireRefs(opts.addChild, '--add-child') : []
  const rmChildren = opts.rmChild ? requireRefs(opts.rmChild, '--rm-child') : []

  const applyType = Boolean(type && !opts.subjectRepo)
  const org = GITHUB_REPO.split('/')[0]
  const typeId = applyType && type ? await lookup(() => resolveIssueTypeId(org, type)) : undefined

  let parentNum: number | null = null
  if (opts.rmParent) {
    parentNum = await lookup(() => getParentNumber(issueNumber))
  }

  const needsSubject = Boolean(
    applyType ||
      blockedBy.length ||
      blocks.length ||
      rmBlockedBy.length ||
      rmBlocks.length ||
      parent ||
      children.length ||
      rmChildren.length ||
      parentNum,
  )
  const subjectNodeId = needsSubject ? await lookup(() => getNodeId(issueNumber, opts.subjectRepo)) : undefined

  const removedParent =
    parentNum && subjectNodeId
      ? {
          parentNum,
          parentNodeId: await lookup(() => getNodeId(parentNum)),
        }
      : undefined

  return {
    subjectNodeId,
    typeId,
    blockedBy: await bindRefs(blockedBy),
    blocks: await bindRefs(blocks),
    rmBlockedBy: await bindRefs(rmBlockedBy),
    rmBlocks: await bindRefs(rmBlocks),
    parent: parent ? (await bindRefs([parent]))[0] : undefined,
    children: await bindRefs(children),
    rmChildren: await bindRefs(rmChildren),
    removedParent,
  }
}

async function applyType(issueNumber: number, canonical: string, resolved: ResolvedWrites): Promise<void> {
  if (!resolved.subjectNodeId || !resolved.typeId) fail('Error: internal: type was not resolved')
  await updateIssueIssueType(resolved.subjectNodeId, resolved.typeId)
  console.log(`Type=${canonical} #${issueNumber}`)
}

async function applyDependencies(issueNumber: number, opts: SetOptions, resolved: ResolvedWrites): Promise<void> {
  const subjStr = subjectStr(issueNumber, opts.subjectRepo)
  const subjectNodeId = resolved.subjectNodeId
  if (opts.blockedBy) {
    if (!subjectNodeId) fail('Error: internal: subject node id was not resolved')
    for (const bound of resolved.blockedBy) {
      await addBlockedBy(subjectNodeId, bound.nodeId)
      console.log(`BlockedBy=${formatRef(bound.ref)} ${subjStr}`)
    }
  }
  if (opts.blocks) {
    if (!subjectNodeId) fail('Error: internal: subject node id was not resolved')
    for (const bound of resolved.blocks) {
      await addBlockedBy(bound.nodeId, subjectNodeId)
      console.log(`Blocks=${formatRef(bound.ref)} ${subjStr}`)
    }
  }
  if (opts.rmBlockedBy) {
    if (!subjectNodeId) fail('Error: internal: subject node id was not resolved')
    for (const bound of resolved.rmBlockedBy) {
      await removeBlockedBy(subjectNodeId, bound.nodeId)
      console.log(`RemovedBlockedBy=${formatRef(bound.ref)} ${subjStr}`)
    }
  }
  if (opts.rmBlocks) {
    if (!subjectNodeId) fail('Error: internal: subject node id was not resolved')
    for (const bound of resolved.rmBlocks) {
      await removeBlockedBy(bound.nodeId, subjectNodeId)
      console.log(`RemovedBlocks=${formatRef(bound.ref)} ${subjStr}`)
    }
  }
}

async function applyParentChild(issueNumber: number, opts: SetOptions, resolved: ResolvedWrites): Promise<void> {
  const subjStr = subjectStr(issueNumber, opts.subjectRepo)
  const subjectNodeId = resolved.subjectNodeId

  if (opts.parent && resolved.parent) {
    if (!subjectNodeId) fail('Error: internal: subject node id was not resolved')
    await addSubIssue(resolved.parent.nodeId, subjectNodeId)
    console.log(`Parent=${formatRef(resolved.parent.ref)} ${subjStr}`)
  }

  if (opts.addChild) {
    if (!subjectNodeId) fail('Error: internal: subject node id was not resolved')
    for (const child of resolved.children) {
      await addSubIssue(subjectNodeId, child.nodeId)
      console.log(`Child=${formatRef(child.ref)} ${subjStr}`)
    }
  }

  if (opts.rmParent) {
    if (resolved.removedParent && subjectNodeId) {
      await removeSubIssue(resolved.removedParent.parentNodeId, subjectNodeId)
      console.log(`RemovedParent=#${resolved.removedParent.parentNum} ${subjStr}`)
    } else {
      console.log(`No parent found for ${subjStr}`)
    }
  }

  if (opts.rmChild) {
    if (!subjectNodeId) fail('Error: internal: subject node id was not resolved')
    for (const child of resolved.rmChildren) {
      await removeSubIssue(subjectNodeId, child.nodeId)
      console.log(`RemovedChild=${formatRef(child.ref)} ${subjStr}`)
    }
  }
}

export async function setIssue(args: string[]): Promise<void> {
  const opts = parseArgs(args)

  if (!opts.issueNumber) fail('Error: Issue number required')

  refuseBody(opts)

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
    opts.rmChild ||
    opts.bodySet ||
    opts.clearBody

  if (!hasAction) {
    fail(
      'Error: Specify --size, --priority, --lane, --type, --blocked-by, --blocks, --rm-blocked-by, --rm-blocks, --parent, --add-child, --rm-parent, --rm-child, --body, --body-file, and/or --clear-body',
    )
  }

  if (opts.status) fail('Error: --status is not supported in the issues-only model (open/closed).')

  if (opts.rmParent && opts.subjectRepo) {
    fail(
      `Error: --rm-parent is not supported for cross-repo subjects (${subjectStr(opts.issueNumber, opts.subjectRepo)}) — use direct GraphQL`,
    )
  }

  // Local spelling first. A rejected value must not reach a lookup or a write.
  if (opts.type && opts.subjectRepo) {
    console.error(
      `Warning: --type is not supported for cross-repo subjects (${opts.subjectRepo}#${opts.issueNumber}) — skipped`,
    )
  }
  const type = opts.type ? resolveType(opts.type) : undefined

  const resolvedLabels = resolveLabelFlags({ priority: opts.priority, size: opts.size, lane: opts.lane })
  const crossRepoLabels = Boolean(opts.subjectRepo && (opts.priority || opts.size || opts.lane))
  if (crossRepoLabels) {
    console.error(
      `Warning: --size/--priority/--lane label sync is not supported for cross-repo subjects (${opts.subjectRepo}#${opts.issueNumber}) — skipped`,
    )
  }
  const labels: LabelFlags = crossRepoLabels ? {} : resolvedLabels

  // Remote lookups that can reject. No mutation has run.
  const resolved = await resolveWrites(opts.issueNumber, opts, type)

  if (type && !opts.subjectRepo) await applyType(opts.issueNumber, type, resolved)
  const unwritten = await writeLabels(opts.issueNumber, labels)

  try {
    await applyDependencies(opts.issueNumber, opts, resolved)
    await applyParentChild(opts.issueNumber, opts, resolved)
  } finally {
    if (unwritten.length > 0) {
      console.error(`Error: label not written for ${unwritten.join(', ')} on #${opts.issueNumber}`)
    }
  }

  if (unwritten.length > 0) process.exit(1)

  if (opts.bodySet || opts.clearBody) {
    try {
      await updateIssueBody(opts.issueNumber, opts.body ?? '', opts.subjectRepo)
    } catch (error) {
      fail(`Error: ${(error as Error).message}`)
    }
    console.log(`Body ${subjectStr(opts.issueNumber, opts.subjectRepo)}`)
  }
}
