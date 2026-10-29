import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ReviewSemanticAssets } from './review-prompts'
import type { TrustedHostPluginPin } from './uw-action-contract.ts'
import { pinnedInstalledRoot } from './uw-plugin-pin.ts'

export type ReviewConfig = {
  canonicalClasses: readonly string[]
  chunker: string
  digest: string
}

export type ReviewClassCatalogue = {
  config: ReviewConfig
  assetDir: string
  classes: string
  canonicalClasses: readonly string[]
}

export type ReviewAssets = ReviewClassCatalogue & ReviewSemanticAssets

/** Skill directory under the pinned install, not a separately declared module path. */
export function installedReviewSkillDir(pluginPin?: TrustedHostPluginPin): string {
  return join(pinnedInstalledRoot(pluginPin), 'skills', 'dev-review')
}

const reviewSkillDir = installedReviewSkillDir()

/** Reads the class catalogue only, without requiring unrelated prompt assets. */
export function loadReviewClassCatalogue(skillDir = reviewSkillDir): ReviewClassCatalogue {
  const classes = readFileSync(join(skillDir, 'review-classes.yml'), 'utf8')
  const canonicalClasses = [...classes.matchAll(/^\s*- class:\s*([a-z][a-z0-9-]*)\s*$/gm)].map((match) => match[1])
  return {
    config: {
      canonicalClasses,
      chunker: join(skillDir, 'chunker.py'),
      digest: join(skillDir, 'digest.py'),
    },
    assetDir: skillDir,
    classes,
    canonicalClasses,
  }
}

/** Reads the sole canonical class catalogue without inventing a parallel taxonomy. */
export function loadReviewConfig(skillDir?: string): ReviewConfig {
  const { config } = loadReviewClassCatalogue(skillDir)
  if (config.canonicalClasses.length === 0) throw new Error('review class catalogue has no canonical classes')
  return config
}

/** Reads every prompt asset once; missing or unreadable bytes refuse preparation. */
export function loadReviewAssets(catalogue: ReviewClassCatalogue = loadReviewClassCatalogue()): ReviewAssets {
  const { assetDir } = catalogue
  return {
    ...catalogue,
    evidencePolicy: readFileSync(join(assetDir, 'evidence-policy.md'), 'utf8'),
    rootCauses: readFileSync(join(assetDir, 'root-causes.md'), 'utf8'),
    smells: readFileSync(join(assetDir, 'review-smells.md'), 'utf8'),
    blindSpots: readFileSync(join(assetDir, 'review-blind-spots.md'), 'utf8'),
  }
}
