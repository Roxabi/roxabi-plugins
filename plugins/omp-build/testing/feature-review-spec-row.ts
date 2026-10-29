import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputManifest } from '../engine/action-input-schema.ts'
import { actionInputManifestSchema } from '../engine/action-input-schema.ts'
import { evidenceDigest } from '../engine/criterion-admission.ts'
import { criterionDeclarationSchema } from '../engine/criterion-evidence-schema.ts'
import { criterionVerdictSchema } from '../engine/criterion-verdict-schema.ts'
import type { PreparedUwAction } from '../roxabi/uw-action-contract.ts'
import { criterionSatisfiedRow } from './criterion-approval.ts'
import type { SimState } from './sandbox/sandbox-types.ts'

export function fixtureSpecRow(action: PreparedUwAction) {
  const stateFile = process.env.GH_SIM_STATE
  if (stateFile === undefined) throw new Error('gh-state-missing')
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as SimState
  const comments = state.issues['42']?.comments ?? []
  const history = decodeHistory({
    scope: { repository: 'acme/app', target: 'acme/app#42' },
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: comments.map((comment, index) => ({
      locator: `acme/app#42:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
    })),
  })
  const issueRecords = history.operations.flatMap((operation) => (operation.record ? [operation.record] : []))
  const pullComments = state.prs['7']?.comments ?? []
  const pullHistory = decodeHistory({
    scope: { repository: 'acme/app', target: 'acme/app#7' },
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: pullComments.map((comment, index) => ({
      locator: `acme/app#7:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
    })),
  })
  const pullRecords = pullHistory.operations.flatMap((operation) => (operation.record ? [operation.record] : []))
  const mandate = issueRecords.find((record) => record.kind === 'mandate')
  if (mandate?.kind !== 'mandate') throw new Error('review-fixture-mandate-missing')
  const directory = dirname(action.snapshot.indexPath)
  const index = readFileSync(action.snapshot.indexPath, 'utf8')
  const manifest = actionInputManifestSchema.parse(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')))
  const fingerprint = actionInputDigest(manifest)
  if (
    fingerprint !== action.snapshot.manifestDigest ||
    fingerprint !== action.inputs.fingerprint ||
    !index.includes(`Fingerprint: ${fingerprint}\n`) ||
    !index.includes('- manifest.json\n')
  )
    throw new Error('review-fixture-sealed-manifest-mismatch')
  const selection = manifest.deliveryData.find((ref) => ref.role === 'implementation')
  if (selection === undefined) throw new Error('review-fixture-implementation-missing')
  const record = selection.record
  const selectedPath = [
    'records',
    encodeURIComponent(selection.role),
    encodeURIComponent(record.scope.repository),
    encodeURIComponent(record.scope.target),
    encodeURIComponent(record.kind),
    encodeURIComponent(record.recordId),
    `${encodeURIComponent(selection.selector)}.json`,
  ].join('/')
  if (!index.includes(`- ${selectedPath}\n`)) throw new Error('review-fixture-implementation-not-indexed')
  const selected = JSON.parse(readFileSync(join(directory, selectedPath), 'utf8')) as unknown
  const authenticated = [...issueRecords, ...pullRecords].find(
    (item) =>
      item.recordId === record.recordId &&
      item.kind === record.kind &&
      item.repository === record.scope.repository &&
      item.target === record.scope.target,
  )
  let authenticatedValue: unknown = authenticated
  for (const component of selection.selector.slice(1).split('/')) {
    if (typeof authenticatedValue !== 'object' || authenticatedValue === null) {
      authenticatedValue = undefined
      break
    }
    const key = component.replace(/~1/g, '/').replace(/~0/g, '~')
    authenticatedValue = (authenticatedValue as Record<string, unknown>)[key]
  }
  if (
    authenticated === undefined ||
    canonicalValueDigest(selected) !== selection.digest ||
    canonicalValueDigest(authenticatedValue) !== selection.digest
  )
    throw new Error('review-fixture-implementation-digest-mismatch')
  if (authenticated.kind === 'fix-result') return correctionSpecRow(selected, manifest, selection)
  return criterionSatisfiedRow({
    mandate,
    inputs: { ...action.inputs, manifest },
    head: manifest.code.head,
    issueRecords,
  })
}

function correctionSpecRow(
  selected: unknown,
  manifest: ActionInputManifest,
  selection: ActionInputManifest['deliveryData'][number],
) {
  const declaration = criterionDeclarationSchema.parse(selected)
  if (declaration.verification !== 'evidence' || declaration.evidence.length !== 1 || manifest.spec.kind !== 'accepted')
    throw new Error('review-fixture-correction-evidence-missing')
  const evidence = declaration.evidence[0]
  if (
    evidence === undefined ||
    evidence.method !== 'test' ||
    evidence.code.commit !== manifest.code.head ||
    evidence.after.versionClaim.code.commit !== manifest.code.head ||
    evidence.after.run.exitCode !== 0 ||
    canonicalValueDigest(evidence.target.spec) !== canonicalValueDigest(manifest.spec.effective.own)
  )
    throw new Error('review-fixture-correction-evidence-mismatch')
  return criterionVerdictSchema.parse({
    target: evidence.target,
    verdict: 'satisfied',
    criterionKind: 'behavior',
    bugRegression: false,
    restoration: 'not-applicable',
    examined: [
      {
        evidence: { receipt: selection.record, evidenceId: evidence.id, digest: evidenceDigest(evidence) },
        truth: 'supported',
        applicability: 'applies',
        codeLink: {
          method: 'test',
          after: {
            support: 'supported',
            reason: 'The fixture probe imports the corrective candidate',
            references: [],
          },
          before: null,
        },
        reason: 'The corrective fixture probe exercises the accepted behavior',
      },
    ],
    reason: 'Independent fixture review supports the corrective candidate',
  })
}
