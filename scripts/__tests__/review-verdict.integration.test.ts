import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '../review-verdict.sh')

const ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

const HEAD = 'a'.repeat(40)
const EVIDENCE = 'https://github.com/Test/test-repo/pull/1#issuecomment-1'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-verdict-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function run(...args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], { cwd: dir, env: ENV, encoding: 'utf8' })
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8', stdio: 'pipe' }).trim()
}

function commit(file: string, content: string): string {
  fs.writeFileSync(path.join(dir, file), content)
  git('add', file)
  git('commit', '-q', '-m', `${file}: ${content}`)
  return git('rev-parse', 'HEAD')
}

describe('review-verdict.sh verdict', () => {
  function verdict(body: string, state = 'open', head = HEAD) {
    const file = path.join(dir, 'comment.txt')
    fs.writeFileSync(file, body)
    return run('verdict', file, state, head)
  }

  it('accepts one verdict line naming the open head, among prose and CRLF line ends', () => {
    const result = verdict(`Reviewed.\r\nreview-verdict v1 head=${HEAD} approve evidence=${EVIDENCE}\r\nThanks\r\n`)
    expect(result).toEqual({ code: 0, stdout: `${EVIDENCE}\n`, stderr: '' })
  })

  it.each([
    ['another head', `review-verdict v1 head=${'b'.repeat(40)} approve evidence=${EVIDENCE}`, 'open', 'verdict names'],
    ['a closed pull request', `review-verdict v1 head=${HEAD} approve evidence=${EVIDENCE}`, 'closed', 'is closed'],
    ['uppercase hex', `review-verdict v1 head=${'A'.repeat(40)} approve evidence=${EVIDENCE}`, 'open', 'no well'],
    ['a missing evidence URL', `review-verdict v1 head=${HEAD} approve`, 'open', 'no well-formed'],
    ['a hostless evidence URL', `review-verdict v1 head=${HEAD} approve evidence=https://?q=x`, 'open', 'no well'],
    ['trailing text', `review-verdict v1 head=${HEAD} approve evidence=${EVIDENCE} later`, 'open', 'no well-formed'],
    [
      'two verdict lines',
      `review-verdict v1 head=${HEAD} approve evidence=${EVIDENCE}\nreview-verdict v1 head=${HEAD} approve evidence=${EVIDENCE}`,
      'open',
      'more than one',
    ],
  ])('refuses %s', (_name, body, state, reason) => {
    const result = verdict(body, state)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(reason)
  })
})

describe('review-verdict.sh carry', () => {
  let reviewed: string

  // main: base → advanced; pr: base → reviewed. Each test then builds the new head on pr.
  beforeEach(() => {
    git('init', '-q', '-b', 'main')
    commit('shared.txt', 'base\n')
    git('switch', '-q', '-c', 'pr')
    reviewed = commit('feature.txt', 'reviewed\n')
    git('switch', '-q', 'main')
    commit('main.txt', 'advanced\n')
    git('switch', '-q', 'pr')
  })

  it('carries a clean merge of the reviewed head with main to its first parent', () => {
    git('merge', '-q', '--no-ff', '-m', 'update from main', 'main')
    expect(run('carry', git('rev-parse', 'HEAD'), 'main')).toEqual({ code: 0, stdout: `${reviewed}\n`, stderr: '' })
  })

  it('refuses a merge that folds in a change of its own', () => {
    git('merge', '-q', '--no-ff', '--no-commit', 'main')
    fs.writeFileSync(path.join(dir, 'feature.txt'), 'unreviewed\n')
    git('commit', '-q', '-am', 'update from main')
    const result = run('carry', git('rev-parse', 'HEAD'), 'main')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('tree differs from the clean merge')
  })

  it('refuses a merge whose conflict was resolved by hand', () => {
    git('switch', '-q', 'main')
    commit('shared.txt', 'main side\n')
    git('switch', '-q', 'pr')
    commit('shared.txt', 'pr side\n')
    expect(spawnSync('git', ['merge', '-q', '--no-ff', 'main'], { cwd: dir, env: ENV }).status).toBe(1)
    fs.writeFileSync(path.join(dir, 'shared.txt'), 'resolved\n')
    git('commit', '-q', '-am', 'resolve')
    const result = run('carry', git('rev-parse', 'HEAD'), 'main')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('do not merge cleanly')
  })

  it('refuses a single-parent head', () => {
    const result = run('carry', commit('feature.txt', 'pushed\n'), 'main')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('not a two-parent merge')
  })

  it('refuses a merge whose second parent is not on the base branch', () => {
    git('switch', '-q', '-c', 'side', 'main')
    commit('side.txt', 'side\n')
    git('switch', '-q', 'pr')
    git('merge', '-q', '--no-ff', '-m', 'merge side', 'side')
    const result = run('carry', git('rev-parse', 'HEAD'), 'main')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('is not on main')
  })
})
