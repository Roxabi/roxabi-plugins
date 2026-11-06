import {
  buildObservedCommitIndex,
  canonicalValueDigest,
  deliveredChildCommit,
  resolveSpecEffective,
} from '../dist/contracts.js'
import type { IntegrationOutput } from '../engine/uw-integration-schema.ts'
import type { ActionStartReceipt } from './feature-approved-context.ts'
import { declaredCriteria } from './feature-implementation-admission.ts'
import { integrationProofInputs } from './uw-action-stage-closure.ts'
import { createInstalledUwReadPort } from './uw-read-port.ts'
import type { GitRunner } from './workflow-checkout.ts'

export class IntegrationRefusal extends Error {}
export function refuse(reason: string): never {
  throw new IntegrationRefusal(reason)
}
const equal = (a: unknown, b: unknown) => canonicalValueDigest(a) === canonicalValueDigest(b)

export async function observeIntegration(
  input: { cwd: string; gh: (cwd: string, args: string[]) => Promise<string>; git: GitRunner },
  opened: ActionStartReceipt,
  structured: IntegrationOutput,
) {
  const manifest = opened.payload.inputs.manifest
  if (
    manifest.purpose !== 'integrate' ||
    manifest.subject.kind !== 'uw' ||
    manifest.spec.kind !== 'accepted' ||
    structured.code.repository !== manifest.code.repository ||
    structured.code.base !== manifest.code.base ||
    manifest.code.referenceCommit !== manifest.code.head ||
    structured.code.referenceCommit !== manifest.code.referenceCommit ||
    structured.code.head !== manifest.code.head
  )
    refuse('integration-code-unbound')
  const uw = manifest.subject.uw
  const read = await createInstalledUwReadPort({ cwd: input.cwd, gh: input.gh }).readUw(uw)
  if (
    read.observation.status !== 'complete' ||
    read.accepted.status !== 'accepted' ||
    !equal(read.accepted.value.ref, manifest.spec.effective.own) ||
    !equal(read.accepted.value.coverage, structured.coverage)
  )
    refuse('integration-observation-changed')
  const observation = read.observation
  const accepted = read.accepted.value
  const effectiveSpec = manifest.spec.effective
  const validateSources = () => {
    const projected = integrationProofInputs(read)
    if (
      !projected.ok ||
      !equal(projected.value.acceptedSources, manifest.acceptedSources) ||
      !equal(projected.value.stageSources, opened.payload.inputs.stageSources)
    )
      refuse('integration-inputs-changed')
    const effective = resolveSpecEffective({
      mode: 'current',
      own: accepted.ref,
      histories: observation.histories,
      graph: observation.graph,
    })
    if (!effective.ok || !equal(effective.value, effectiveSpec)) refuse('integration-observation-changed')
    const boundSources = [...manifest.acceptedSources, ...opened.payload.inputs.stageSources]
    if (projected.value.childSources.some((source) => !boundSources.some((bound) => equal(bound, source))))
      refuse('integration-child-source-unbound')
  }
  validateSources()
  const index = buildObservedCommitIndex(observation)
  if (!index.ok) refuse('integration-observation-changed')
  const validateCriteria = () => {
    if (
      !declaredCriteria(structured.criteria) ||
      structured.criteria.length !== accepted.snapshot.spec.criteria.length ||
      structured.criteria.some(
        (item) =>
          !equal(item.target.spec, accepted.ref) ||
          !accepted.snapshot.spec.criteria.some((criterion) => criterion.id === item.target.id),
      )
    )
      refuse('integration-criterion-mismatch')
  }
  validateCriteria()
  const proveChildren = async () => {
    if (structured.children.length !== accepted.children.length) refuse('integration-child-mismatch')
    const childCommits: string[] = []
    for (const commitment of accepted.children) {
      const completed = [...read.completion.completions.values()].find(
        (item) => item.uw.repository === commitment.scope.repository && item.uw.target === commitment.scope.target,
      )
      if (completed?.state !== 'complete' || completed.spec.version !== commitment.specVersion)
        refuse('integration-child-unproven')
      const matches = structured.children.filter(
        (item) =>
          equal(item.spec, completed.spec) &&
          equal(item.code, completed.code) &&
          item.sources.length === completed.sources.length &&
          item.sources.every((source) => completed.sources.some((expected) => equal(source, expected))),
      )
      if (matches.length !== 1) refuse('integration-child-mismatch')
      const commit = deliveredChildCommit(observation.delivery, completed, index.value)
      if (
        commit === null ||
        (await input.git(input.cwd, ['merge-base', '--is-ancestor', commit, structured.code.head])).code !== 0
      )
        refuse('integration-child-not-contained')
      childCommits.push(commit)
    }
    return childCommits
  }
  const childCommits = await proveChildren()
  return { manifest, uw, read, accepted, childCommits }
}
