import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ReviewConfig = {
  canonicalClasses: readonly string[]
  chunker: string
  digest: string
}

const reviewSkillDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills', 'dev-review')

/** Reads the sole canonical class catalogue without inventing a parallel taxonomy. */
export function loadReviewConfig(skillDir = reviewSkillDir): ReviewConfig {
  const catalogue = readFileSync(join(skillDir, 'review-classes.yml'), 'utf8')
  const canonicalClasses = [...catalogue.matchAll(/^\s*- class:\s*([a-z][a-z0-9-]*)\s*$/gm)].map((match) => match[1])
  if (canonicalClasses.length === 0) throw new Error('review class catalogue has no canonical classes')
  return {
    canonicalClasses,
    chunker: join(skillDir, 'chunker.py'),
    digest: join(skillDir, 'digest.py'),
  }
}
