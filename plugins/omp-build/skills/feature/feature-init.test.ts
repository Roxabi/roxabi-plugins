import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Gh, plan, readFacts } from './feature-init'

// Verbatim copies of the target repos' files, and the `gh` answers recorded
// from those repos (labels, head of the last merged PR, its check runs).
const FIXTURES = path.resolve(import.meta.dirname, '__fixtures__', 'feature-init')

function recorded(repo: string, file: string): string {
  return readFileSync(path.join(FIXTURES, repo, 'gh', file), 'utf8')
}

function recordedGh(repo: string): Gh {
  return (args) => {
    if (args[0] === 'label') return recorded(repo, 'labels.txt')
    if (args[0] === 'pr') return recorded(repo, 'merged-head.txt')
    const head = recorded(repo, 'merged-head.txt').trim()
    if (args[0] === 'api' && args[1] === `repos/{owner}/{repo}/commits/${head}/check-runs`) {
      return recorded(repo, 'check-runs.txt')
    }
    return null
  }
}

const offline: Gh = () => null

function realRunNames(repo: string): string[] {
  return recorded(repo, 'check-runs.txt').split('\n').filter(Boolean)
}

describe('feature init on the metalyde files', () => {
  const dir = path.join(FIXTURES, 'metalyde')
  const facts = readFacts(dir, recordedGh('metalyde'))

  it('lists the adoption gaps', () => {
    expect(plan(facts)).toEqual([
      'tracker contract',
      'label migration',
      'semctx hooks',
      'CI job semctx-working-empty',
      '4 orphan contracts',
      'assertledger + vitest adapter',
      'landing = merge-on-green with trufflehog + ci',
      'worktree block',
      'release.post_merge asked',
    ])
  })

  it('requires only real check-run names', () => {
    expect(facts.checks.length).toBeGreaterThan(0)
    for (const name of facts.checks) expect(realRunNames('metalyde')).toContain(name)
  })

  it('watches every check when a gate has no real run, rather than dropping that gate', () => {
    const noSecretRun: Gh = (args) => {
      const answer = recordedGh('metalyde')(args)
      return args[0] === 'api' && answer ? answer.replace(/^trufflehog\n/m, '') : answer
    }
    expect(readFacts(dir, noSecretRun).checks).toEqual([])
  })

  it('watches every check when GitHub cannot name the runs', () => {
    const blind = readFacts(dir, offline)
    expect(blind.checks).toEqual([])
    expect(plan(blind)).toContain('landing = merge-on-green with every check')
    expect(plan(blind)).not.toContain('label migration')
  })
})

describe('feature init on the boilerplate-cf files', () => {
  const dir = path.join(FIXTURES, 'boilerplate-cf')
  const facts = readFacts(dir, recordedGh('boilerplate-cf'))

  it('lists the adoption gaps', () => {
    expect(plan(facts)).toEqual([
      'codegraph proposed',
      'landing = merge-on-green with TruffleHog + ci + semctx-working-empty',
      'release.post_merge asked',
    ])
  })

  it('requires only real check-run names', () => {
    for (const name of facts.checks) expect(realRunNames('boilerplate-cf')).toContain(name)
  })
})
