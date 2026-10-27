/**
 * Production mutation-port adapter for the injected issue writer.
 *
 * Repository selection and complete readback are supplied by the caller. This
 * adapter neither discovers a repository nor imports the standalone CLI.
 */

import type { IssueRef, IssueWriteObservation, IssueWritePorts } from '../domain/issue-write'
import {
  ADD_BLOCKED_BY_MUTATION,
  ADD_SUB_ISSUE_MUTATION,
  REMOVE_BLOCKED_BY_MUTATION,
  REMOVE_SUB_ISSUE_MUTATION,
} from '../queries'

/** Existing GitHub command runners can satisfy this without importing omp-build. */
export type GhRunner = (args: readonly string[]) => Promise<string>

/** A complete logical reader, normally backed by the native paginated graph reader. */
export type CompleteIssueReader = (issue: IssueRef) => Promise<IssueWriteObservation>

export type GhIssueWritePortOptions = {
  gh: GhRunner
  read: CompleteIssueReader
}

function apiPath(issue: IssueRef): string {
  return `repos/${issue.repository}/issues/${issue.number}`
}

async function nodeId(gh: GhRunner, issue: IssueRef): Promise<string> {
  const output = await gh(['api', apiPath(issue), '--jq', '.node_id'])
  const id = output.trim()
  if (id === '') throw new Error(`GitHub did not return a node ID for ${issue.repository}#${issue.number}`)
  return id
}

async function graphql(gh: GhRunner, query: string, variables: Record<string, string>): Promise<void> {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [name, value] of Object.entries(variables)) args.push('-f', `${name}=${value}`)
  await gh(args)
}

function parseCreatedNumber(output: string, repository: string): number {
  const number = Number(output.trim())
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`GitHub did not return a valid issue number for ${repository}: ${output}`)
  }
  return number
}

/**
 * Adapt a supplied `gh` runner and complete-reader to generic IssueWritePorts.
 * The generic domain writer owns validation, ordering, preconditions and
 * readback comparison; this adapter only issues native mutations.
 */
export function createGhIssueWritePorts(options: GhIssueWritePortOptions): IssueWritePorts {
  const { gh, read } = options
  return {
    read,
    async create({ repository, title, body }): Promise<IssueRef> {
      const output = await gh([
        'api',
        '--method',
        'POST',
        `repos/${repository}/issues`,
        '--raw-field',
        `title=${title}`,
        '--raw-field',
        `body=${body}`,
        '--jq',
        '.number',
      ])
      return { repository, number: parseCreatedNumber(output, repository) }
    },
    async patch(issue, input): Promise<void> {
      const args = ['api', '--method', 'PATCH', apiPath(issue)]
      if (input.title !== undefined) args.push('--raw-field', `title=${input.title}`)
      args.push('--raw-field', `body=${input.body}`)
      await gh(args)
    },
    async updateLabels(issue, input): Promise<void> {
      const args = ['issue', 'edit', String(issue.number), '--repo', issue.repository]
      if (input.add.length) args.push('--add-label', input.add.join(','))
      if (input.remove.length) args.push('--remove-label', input.remove.join(','))
      await gh(args)
    },
    async addChild(parent, child): Promise<void> {
      await graphql(gh, ADD_SUB_ISSUE_MUTATION, {
        parentId: await nodeId(gh, parent),
        childId: await nodeId(gh, child),
      })
    },
    async removeChild(parent, child): Promise<void> {
      await graphql(gh, REMOVE_SUB_ISSUE_MUTATION, {
        parentId: await nodeId(gh, parent),
        childId: await nodeId(gh, child),
      })
    },
    async addBlocker(issue, blocker): Promise<void> {
      await graphql(gh, ADD_BLOCKED_BY_MUTATION, {
        issueId: await nodeId(gh, issue),
        blockingId: await nodeId(gh, blocker),
      })
    },
    async removeBlocker(issue, blocker): Promise<void> {
      await graphql(gh, REMOVE_BLOCKED_BY_MUTATION, {
        issueId: await nodeId(gh, issue),
        blockingId: await nodeId(gh, blocker),
      })
    },
  }
}
