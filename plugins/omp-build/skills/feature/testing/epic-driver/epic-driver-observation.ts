import { spawnSync } from 'node:child_process'
import { expect } from 'vitest'
import type { Gh } from '../../../../adapters/github/types.ts'
import { createInstalledUwReadPort } from '../../../../roxabi/uw-read-port.ts'
import { ME } from './epic-driver-records.ts'
import { sandboxOf } from './epic-driver-sandbox.ts'

/** Assert the actual same-sandbox observation required by a control consumer. */
export async function expectCompleteEpicObservation() {
  const box = sandboxOf()
  const gh: Gh = async (cwd, args) => {
    const result = spawnSync('gh', args, { cwd, env: box.env, encoding: 'utf8' })
    if (result.error || result.status !== 0)
      throw new Error(`gh ${args.join(' ')}: ${result.stderr || result.error?.message}`)
    return result.stdout
  }
  const read = await createInstalledUwReadPort({ cwd: box.epic, gh, readAuthor: ME }).readUw({
    repository: 'o/r',
    target: 'o/r#1',
  })
  const causal = read.causalObservation
  const facts = {
    observation: read.observation.status,
    diagnostics: read.observation.status === 'incomplete' ? read.observation.diagnostics : [],
    causal: causal.status,
    sameHistories: causal.status === 'complete' && causal.histories === read.histories,
    sameCatalogues: causal.status === 'complete' && causal.catalogues === read.catalogues,
  }
  expect(facts, JSON.stringify(facts)).toEqual({
    observation: 'complete',
    diagnostics: [],
    causal: 'complete',
    sameHistories: true,
    sameCatalogues: true,
  })
}
