import { execFileSync } from 'node:child_process'
import { specDigest } from '../../../../engine/record-digests.ts'
import { trackerReference } from '../../../../roxabi/review-semantic-context.ts'
import { PROOF_PIN_PATHS } from '../../../../roxabi/workflow-pins.ts'
import { roxabiWorkflowFixtures } from '../../../../testing/roxabi-presets.ts'
import { git, readSim } from '../../__fixtures__/proof/sandbox-repository.ts'
import type { Box } from '../../__fixtures__/proof/sandbox-types.ts'
import { proofSemanticContext } from '../../proof-context.ts'
import { hashReviewInput } from '../../proof-context-hash.ts'
import { ME } from './environment.ts'

const { linkedLandingAuthority } = roxabiWorkflowFixtures()

/** The `baseRefOid` GitHub reports for `pr`: the tip it recorded, which a push to the base branch leaves. */
export function recordedBaseOf(box: Box, pr: number): string | undefined {
  const view: { baseRefOid?: string } = JSON.parse(
    execFileSync('gh', ['pr', 'view', String(pr), '--json', 'baseRefOid'], {
      cwd: box.principal,
      env: box.env,
      encoding: 'utf8',
    }),
  )
  return view.baseRefOid
}

export function livePinsAt(box: Box, baseTip: string): { sourceCommit: string; path: string; blob: string | null }[] {
  const toplevel = git(box, box.principal, ['rev-parse', '--show-toplevel'])
  return PROOF_PIN_PATHS.map((pinPath) => {
    try {
      const blob = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${baseTip}:${pinPath}`], {
        cwd: toplevel,
        env: box.env,
        encoding: 'utf8',
      }).trim()
      return { sourceCommit: baseTip, path: pinPath, blob: /^[0-9a-f]{40}$/.test(blob) ? blob : null }
    } catch {
      return { sourceCommit: baseTip, path: pinPath, blob: null }
    }
  })
}

/** Genuine linked mandate (issue) + workflow-binding (PR). Closing text is not authority. */
export function landingAuthorityFor(box: Box, pr: number, body: string, baseTipOverride?: string, specIssue?: number) {
  const pull = readSim(box).prs[String(pr)]
  if (!pull) return null
  let number: number | null = specIssue ?? null
  if (number === null) {
    try {
      number = trackerReference(body, pull.headRefName)
    } catch {
      number = null
    }
  }
  if (number === null && typeof pull.closes?.[0] === 'number') number = pull.closes[0]
  if (number === null) return null
  const issue = readSim(box).issues[String(number)]
  if (issue?.state !== 'OPEN') return null
  const baseTip = baseTipOverride ?? recordedBaseOf(box, pr) ?? box.sha[pull.baseRefName]
  if (typeof baseTip !== 'string' || !/^[0-9a-f]{40}$/.test(baseTip)) return null
  return linkedLandingAuthority({
    repository: 'acme/app',
    issueNumber: number,
    prNumber: pr,
    branch: pull.headRefName,
    base: pull.baseRefName,
    issueBody: issue.body,
    proofPins: livePinsAt(box, baseTip),
    lineageHead: pull.headRefOid,
    author: ME,
  })
}

export function linkedReviewInput(
  box: Box,
  pr: number,
  head: string,
  body: string,
  lastEditedAt: string | null,
  baseTip?: string,
): string | null {
  const authority = landingAuthorityFor(box, pr, body, baseTip)
  if (authority !== null) {
    if (authority.mandate.kind !== 'mandate') throw new Error('linked landing seed lost its mandate kind')
    const mandate = authority.mandate
    const digest = specDigest(mandate.payload.spec.body)
    const config = mandate.payload.config
    const semantic = proofSemanticContext({
      mode: 'bound',
      binding: { recordId: authority.binding.recordId, scope: authority.issueScope },
      acceptedSpec: {
        reference: mandate.payload.spec.reference,
        body: mandate.payload.spec.body,
        digest,
        chain: [
          {
            kind: 'mandate',
            recordId: mandate.recordId,
            scope: authority.issueScope,
            specDigest: digest,
          },
        ],
        sourceRefs: [{ scope: authority.issueScope, recordId: mandate.recordId, kind: 'mandate' }],
      },
      additionalRequirements: [],
      effectiveConfig: {
        productVersion: config.productVersion,
        version: config.version,
        digest: config.digest,
        serialized: JSON.stringify({
          productVersion: config.productVersion,
          version: config.version,
          digest: config.digest,
          additionalRequirements: [],
        }),
      },
    })
    if ('ok' in semantic) throw new Error(semantic.error)
    return hashReviewInput('acme/app', { pr, candidate: head }, { body, lastEditedAt }, null, null, semantic)
  }
  const pull = readSim(box).prs[String(pr)]
  let number: number | null
  try {
    number = trackerReference(body, pull?.headRefName ?? '')
  } catch {
    return null
  }
  const issue = number === null ? undefined : readSim(box).issues[String(number)]
  const currentSpec =
    issue?.state === 'OPEN' ? { reference: `#${number}`, body: issue.body, digest: specDigest(issue.body) } : null
  const semantic = proofSemanticContext({
    mode: 'standalone',
    binding: null,
    acceptedSpec: null,
    currentSpec,
    effectiveConfig: null,
    additionalRequirements: [],
  })
  if ('ok' in semantic) throw new Error(semantic.error)
  return hashReviewInput('acme/app', { pr, candidate: head }, { body, lastEditedAt }, null, null, semantic)
}
