import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generateObjective, refuseForeignCommits, resolveTicketBranch } from './epic'

const child = (number: number, blockedBy: number[] = [], hasScope = true) => ({
  number,
  title: `t${number}`,
  blockedBy,
  hasScope,
})

describe('epic objective', () => {
  it('orders children by blocked_by and states the stop policy', () => {
    const result = generateObjective({ number: 575 }, [child(4, [3]), child(3, [1]), child(1)])
    expect(result).toMatchObject({ order: [1, 3, 4] })
    if (!('objective' in result)) throw new Error('expected an objective')
    expect(result.objective).toContain('goal drop')
    expect(result.objective).toContain('revue finale')
    expect(result.objective).toContain('sauter les dépendants')
  })

  it('refuses a child that has no scope', () => {
    expect(generateObjective({ number: 575 }, [child(1, [], false)])).toEqual({ error: 'missing scope: 1' })
  })
})

describe('epic entry', () => {
  it('resolves a ticket branch inside the epic and refuses a foreign one', () => {
    expect(resolveTicketBranch('feat/577-issue-triage', [577, 578])).toEqual({ ticket: 577 })
    expect(resolveTicketBranch('feat/999-other', [577])).toEqual({ error: 'foreign ticket' })
  })

  it('refuses a foreign commit on a ticket branch', () => {
    expect(refuseForeignCommits([{ sha: 'aaa', ticket: 577 }, { sha: 'bbb', ticket: 578 }], 577)).toEqual({
      error: 'foreign commit bbb',
    })
    expect(refuseForeignCommits([{ sha: 'aaa', ticket: 577 }], 577)).toEqual({ ok: true })
  })
})


describe('handoff docs', () => {
  it('describes /move and /goal, not an operator /wt handoff', () => {
    const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf-8')
    const skill = readFileSync(fileURLToPath(new URL('./SKILL.md', import.meta.url)), 'utf-8')
    expect(readme).toContain('/move')
    expect(readme).toContain('/goal')
    expect(skill).toContain('/move')
    expect(skill).toContain('/goal')
    expect(readme).not.toContain("operator's `/wt`")
    expect(skill).not.toContain('saisis `/wt')
  })
})
