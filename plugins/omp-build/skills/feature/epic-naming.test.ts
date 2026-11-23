import { describe, expect, it } from 'vitest'
import { baseFromStack } from './epic-ci'
import { ticketOfBranch, ticketOfSubject } from './epic-claims'
import { BASE_NAME, branchFor, RUN_ID } from './epic-naming'

describe('mandate identity', () => {
  it('accepts an 8-character run id and a branch base, not a revision', () => {
    expect(RUN_ID.test('run00001')).toBe(true)
    expect(RUN_ID.test('RUN00001')).toBe(false)
    expect(RUN_ID.test('run0001')).toBe(false)
    expect(RUN_ID.test('run0000!')).toBe(false)
    expect(BASE_NAME.test('main')).toBe(true)
    expect(BASE_NAME.test('staging')).toBe(true)
    expect(BASE_NAME.test('main..x')).toBe(false)
    expect(BASE_NAME.test('main~1')).toBe(false)
    expect(BASE_NAME.test('main^')).toBe(false)
    expect(BASE_NAME.test('main@{1}')).toBe(false)
    expect(BASE_NAME.test('main:x')).toBe(false)
  })
})

describe('branch claims', () => {
  it.each<[string | null, number | null]>([
    ['feat/577-issue-triage', 577],
    ['fix/577', 577],
    ['feat/5770-x', 5770],
    ['feat/577x', null],
    ['feat/foo/577-x', null],
    ['577-x', null],
    ['main', null],
    ['', null],
    [null, null],
  ])('ticketOfBranch(%j) → %j', (name, expected) => {
    expect(ticketOfBranch(name)).toBe(expected)
  })
})

describe('branchFor', () => {
  it.each<[string, string[], string]>([
    ['fix(driver): Handle résumé edge', [], 'fix/5-handle-resume-edge'],
    ['docs: Explain goal runs', ['bug'], 'docs/5-explain-goal-runs'],
    ['Add the epic driver', ['bug'], 'fix/5-add-the-epic-driver'],
    ['Add the epic driver', [], 'feat/5-add-the-epic-driver'],
    ['wip: something odd', [], 'feat/5-something-odd'],
    ['feat!: one two three four five six seven eight', [], 'feat/5-one-two-three-four-five-six'],
    ['🚀 !!!', [], 'feat/5'],
  ])('%j %j → %s, which claims the child', (title, labels, expected) => {
    const name = branchFor({ number: 5, title, labels })
    expect(name).toBe(expected)
    expect(ticketOfBranch(name)).toBe(5)
  })
})

describe('commit claims', () => {
  it.each<[string, number | null]>([
    ['feat(epic): add the driver (#620)', 620],
    ['Revert "feat(epic): add the driver (#620)"', 620],
    ['wip: goal-stop timeout (#620)  ', 620],
    ['fix: thing (#620) and more', null],
    ['fix: thing #620', null],
    ['Merge pull request #12 from acme/feat/620-x', null],
  ])('ticketOfSubject(%j) → %j', (subject, expected) => {
    expect(ticketOfSubject(subject)).toBe(expected)
  })
})

describe('baseFromStack', () => {
  const main = () => 'main'
  it.each<[string, unknown, { base: string } | { error: string }]>([
    ['trunk → the default branch', { release: { model: 'trunk' } }, { base: 'main' }],
    [
      'staging-train → staging, whatever the default branch',
      { release: { model: 'staging-train' } },
      { base: 'staging' },
    ],
    ['an unknown model is refused', { release: { model: 'promote' } }, { error: expect.stringContaining('promote') }],
    ['no release.model is refused', { release: {} }, { error: expect.stringContaining('undefined') }],
    ['release not a map is refused', { release: 'trunk' }, { error: expect.any(String) }],
    ['an empty document is refused', null, { error: expect.any(String) }],
  ])('%s', (_name, doc, expected) => {
    expect(baseFromStack(doc, main)).toEqual(expected)
  })

  it('asks for the default branch only under trunk', () => {
    let asked = 0
    const count = () => {
      asked++
      return 'main'
    }
    baseFromStack({ release: { model: 'staging-train' } }, count)
    expect(asked).toBe(0)
    baseFromStack({ release: { model: 'trunk' } }, count)
    expect(asked).toBe(1)
  })

  it.each(['main~1', '', 'a..b'])('refuses a default branch git would misread (%j)', (answer) => {
    expect(baseFromStack({ release: { model: 'trunk' } }, () => answer)).toMatchObject({ error: expect.any(String) })
  })
})
