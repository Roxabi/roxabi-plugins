import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { actionInputDigest } from '../action-input.ts'
import type { ActionInputs } from '../action-input-schema.ts'
import { createReviewClassCatalogues } from '../review-class-catalogue.ts'

const catalogueBytes = readFileSync(new URL('../../skills/dev-review/review-classes.yml', import.meta.url))

export function cataloguesForInputs(...inputs: readonly ActionInputs[]) {
  return createReviewClassCatalogues(
    inputs.flatMap((input) =>
      input.manifest.plugin.files
        .filter((file) => file.path === `${input.manifest.plugin.root}/skills/dev-review/review-classes.yml`)
        .map((ref) => ({ ref, contents: { ok: true as const, value: catalogueBytes } })),
    ),
  )
}

/** Pin the real installed test catalogue bytes into the authenticated producer action. */
export function withPinnedCatalogue(inputs: ActionInputs): ActionInputs {
  const bytes = catalogueBytes
  const plugin = inputs.manifest.plugin
  const pin = {
    source: 'git-file' as const,
    repository: plugin.repository,
    commit: plugin.commit,
    path: `${plugin.root}/skills/dev-review/review-classes.yml`,
    digest: createHash('sha256').update(bytes).digest('hex'),
  }
  const manifest = {
    ...inputs.manifest,
    plugin: { ...plugin, files: [...plugin.files.filter((file) => file.path !== pin.path), pin] },
  }
  return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
}
