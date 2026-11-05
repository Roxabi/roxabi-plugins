import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { actionInputDigest } from '../engine/action-input.ts'
import type { ActionInputManifest, ActionInputs } from '../engine/action-input-schema.ts'
import { parseRecord } from '../engine/record-construction.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import {
  catalogueForAction,
  createReviewClassCatalogues,
  reviewClassCatalogueRef,
} from '../engine/review-class-catalogue.ts'
import { fixtureReviewCatalogueReads } from './action-input-fixtures.ts'
import { roxabiRecordFixtures } from './roxabi-presets.ts'

type Plugin = ActionInputManifest['plugin']

function committedBytes(cwd: string, commit: string, path: string): Buffer {
  return execFileSync('git', ['-C', cwd, 'show', `${commit}:${path}`])
}

/** Pin each represented fixture file to bytes from the actual tooling Git commit. */
export function committedFixturePlugin(cwd: string, plugin: Plugin, commit: string): Plugin {
  if (plugin.repository !== 'Roxabi/roxabi-plugins') throw new Error('Unexpected fixture tooling repository')
  const packageJson: unknown = JSON.parse(committedBytes(cwd, commit, `${plugin.root}/package.json`).toString('utf8'))
  if (
    packageJson === null ||
    typeof packageJson !== 'object' ||
    !('version' in packageJson) ||
    typeof packageJson.version !== 'string'
  )
    throw new Error('Committed fixture plugin has no version')
  return {
    ...plugin,
    version: packageJson.version,
    commit,
    files: plugin.files.map((file) => ({
      ...file,
      repository: plugin.repository,
      commit,
      digest: createHash('sha256')
        .update(committedBytes(cwd, commit, file.path))
        .digest('hex'),
    })),
  }
}

/** Rebind a captured fixture action and recompute its canonical fingerprint. */
export function committedFixtureInputs(cwd: string, inputs: ActionInputs, commit: string): ActionInputs {
  const manifest = { ...inputs.manifest, plugin: committedFixturePlugin(cwd, inputs.manifest.plugin, commit) }
  return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
}

/** Rebind the captured action of each workflow receipt without altering its result. */
export function committedFixtureRecords(
  cwd: string,
  records: readonly CanonicalRecord[],
  commit: string,
): CanonicalRecord[] {
  return records.map((record) => {
    if (record.kind !== 'action-receipt') return record
    const inputs = committedFixtureInputs(cwd, record.payload.inputs, commit)
    const parsed = parseRecord({ ...record, payload: { ...record.payload, inputs } })
    if (!parsed.ok)
      throw new Error(`Cannot rebind fixture receipt ${record.recordId}: ${JSON.stringify(parsed.diagnostics)}`)
    return parsed.value
  })
}

/** Matching evidence for the actual captured action and the existing fictional fixture actions. */
export function committedFixtureProjection(cwd: string, inputs: ActionInputs) {
  const selected = reviewClassCatalogueRef(inputs)
  if (!selected.ok) throw new Error(`Cannot select fixture catalogue: ${JSON.stringify(selected.diagnostics)}`)
  if (selected.value.repository !== 'Roxabi/roxabi-plugins') throw new Error('Unexpected fixture catalogue repository')
  const bytes = committedBytes(cwd, selected.value.commit, selected.value.path)
  const catalogues = createReviewClassCatalogues([
    ...fixtureReviewCatalogueReads(),
    { ref: selected.value, contents: { ok: true, value: bytes } },
  ])
  const verified = catalogueForAction(inputs, catalogues)
  if (!verified.ok) throw new Error(`Cannot load fixture catalogue: ${JSON.stringify(verified.diagnostics)}`)
  return { ...roxabiRecordFixtures().projection, catalogues }
}
