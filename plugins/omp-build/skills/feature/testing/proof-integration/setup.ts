import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { git, readSim, writeSim } from '../../__fixtures__/proof/sandbox-repository'
import type { Box } from '../../__fixtures__/proof/sandbox-types'
import { landingAuthorityFor, linkedReviewInput } from './authority'
import { type FixtureComment, type FixtureReview, fixtureReviewBodies, proofFramePrefix } from './data'
import { ME } from './environment'
import { workflowRead } from './workflow'

/** Producer stand-ins that log any call and fail. */
export function instrument(box: Box): void {
  const dir = path.join(box.root, 'producers')
  mkdirSync(dir)
  for (const name of ['semctx', 'assertledger']) {
    const file = path.join(dir, name)
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> '${path.join(box.root, 'producer-calls.log')}'\nexit 99\n`)
    chmodSync(file, 0o755)
  }
  box.env.PATH = `${dir}:${box.env.PATH}`
}

export function producerCalls(box: Box): string[] {
  const log = path.join(box.root, 'producer-calls.log')
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
}

const WORKFLOW_BINDING_PREFIX = '<!-- omp-build-record v=1 kind=workflow-binding '
export function isWorkflowBindingBody(body: string): boolean {
  return body.startsWith(WORKFLOW_BINDING_PREFIX)
}

export function isProducerProofBody(text: string): boolean {
  return text.startsWith(proofFramePrefix('semctx')) || text.startsWith(proofFramePrefix('assertledger'))
}

export function rewriteProducerProofs(box: Box, pr: number, next: string[] | ((proofs: string[]) => string[])): void {
  writeSim(box, (state) => {
    const pull = state.prs[String(pr)]
    if (!pull) throw new Error(`no PR ${pr}`)
    const bindings = pull.comments.filter((comment) => isWorkflowBindingBody(comment.body))
    const proofs = pull.comments.filter((comment) => isProducerProofBody(comment.body))
    const rest = pull.comments.filter(
      (comment) => !isWorkflowBindingBody(comment.body) && !isProducerProofBody(comment.body),
    )
    const bodies = typeof next === 'function' ? next(proofs.map((comment) => comment.body)) : next
    pull.comments = [
      ...bindings,
      ...bodies.map((body, index) => ({
        author: ME,
        body,
        id: proofs[index]?.id,
        createdAt: proofs[index]?.createdAt,
        updatedAt: proofs[index]?.updatedAt,
      })),
      ...rest,
    ]
  })
}

export function prepare(
  box: Box,
  pr: number,
  {
    comments,
    body = 'Closes #1\n',
    armed = null,
    binding = true,
    landingAuthority = true,
    baseTip,
    specIssue,
  }: {
    comments: FixtureComment[]
    body?: string
    armed?: string | null
    binding?: boolean
    landingAuthority?: boolean
    baseTip?: string
    specIssue?: number
  },
): void {
  const authority = landingAuthority ? landingAuthorityFor(box, pr, body, baseTip, specIssue) : null
  if (landingAuthority && authority === null) {
    throw new Error(`landing authority unavailable for PR ${pr}; refusing standalone landing fixtures`)
  }
  const reviews = comments.filter((comment): comment is FixtureReview => typeof comment !== 'string')
  const sourceComments = comments.filter((comment): comment is string => typeof comment === 'string')
  writeSim(box, (state) => {
    const pull = state.prs[String(pr)]
    if (!pull) throw new Error(`no PR ${pr}`)
    const bindingBodies = authority?.bindingBodies ?? []
    pull.comments = [...bindingBodies, ...sourceComments].map((body) => ({ author: ME, body }))
    pull.body = body
    pull.lastEditedAt = null
    pull.labels = armed ? ['reviewed'] : []
    pull.autoMerge = armed ? { enabledAt: '2026-01-01T00:00:00Z', matchHeadCommit: armed } : null
    if (authority !== null && authority.issueBodies.length > 0) {
      const issueNumber = Number(authority.issueScope.target.split('#').at(-1))
      const issue = state.issues[String(issueNumber)]
      if (!issue) throw new Error(`no issue ${issueNumber} for landing mandate`)
      issue.comments = authority.issueBodies.map((text) => ({ author: ME, body: text }))
    }
  })
  if (binding) bindFixtureReview(box, pr, reviews, baseTip)
}

/** Append each supplied review after body + producer bytes are already on the PR. */
export function bindFixtureReview(box: Box, pr: number, reviews: readonly FixtureReview[], baseTip?: string): void {
  const view: { headRefOid: string } = JSON.parse(
    execFileSync('gh', ['pr', 'view', String(pr), '--json', 'headRefOid'], {
      cwd: box.principal,
      env: box.env,
      encoding: 'utf8',
    }),
  )
  const nul = String.fromCharCode(0)
  const checkout = git(box, box.principal, ['worktree', 'list', '--porcelain', '-z'])
    .split(nul + nul)
    .find((entry) => entry.split(nul).includes(`HEAD ${view.headRefOid}`))
    ?.split(nul)[0]
    ?.slice('worktree '.length)
  const captured = checkout
    ? workflowRead(box, checkout, pr, view.headRefOid, 'captureReviewInput')
    : { ok: false as const }
  if (reviews.length === 0) return
  const pull = readSim(box).prs[String(pr)]
  if (!pull) throw new Error(`no PR ${pr}`)
  const hasProofs = pull.comments.some((comment) => isProducerProofBody(comment.body))
  let input: string | null = null
  if (checkout && captured.ok && captured.input) {
    input = captured.input
  } else if (!hasProofs) {
    input = linkedReviewInput(box, pr, view.headRefOid, pull.body, pull.lastEditedAt ?? null, baseTip)
  } else {
    throw new Error(
      `product captureReviewInput failed while producer proofs are present for PR ${pr}` +
        `${checkout ? '' : ' (no checkout for head)'}` +
        `${captured && 'ok' in captured && captured.ok === false ? `; ${JSON.stringify(captured)}` : ''}`,
    )
  }
  if (!input) return
  writeSim(box, (state) => {
    const current = state.prs[String(pr)]
    if (!current) throw new Error(`no PR ${pr}`)
    current.comments.push(
      ...reviews.flatMap((review) =>
        fixtureReviewBodies(pr, { ...review, head: view.headRefOid }, input).map((body) => ({
          author: ME,
          body,
          ...(review.createdAt === undefined ? {} : { createdAt: review.createdAt }),
          ...(review.updatedAt === undefined ? {} : { updatedAt: review.updatedAt }),
        })),
      ),
    )
  })
}
