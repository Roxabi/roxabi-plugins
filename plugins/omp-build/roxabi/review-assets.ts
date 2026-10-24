import { readFile } from 'node:fs/promises'

import type { ReviewSemanticAssets } from './review-prompts'

export type ReviewAssetPaths = {
  evidencePolicy: string
  rootCauses: string
  classes: string
  smells: string
  blindSpots: string
}

/** Reads every prompt asset once; missing or unreadable bytes refuse preparation. */
export async function loadReviewAssets(paths: ReviewAssetPaths): Promise<ReviewSemanticAssets> {
  const entries = await Promise.all(
    Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, 'utf8')] as const),
  )
  const assets = Object.fromEntries(entries)
  return {
    evidencePolicy: assets.evidencePolicy ?? '',
    rootCauses: assets.rootCauses ?? '',
    classes: assets.classes ?? '',
    smells: assets.smells ?? '',
    blindSpots: assets.blindSpots ?? '',
  }
}
