import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { githubScope } from '../github/transport.ts'
import { readComposedWorkflowHistory } from '../github-workflow/history.ts'

// Native page-one partners must both enter before either may finish. A finite
// deadline makes serial reads refuse rather than deadlock the test process.
const fakeGh = String.raw`#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const dir = process.env.COMPOSED_HISTORY_TEST_DIR
const args = process.argv.slice(2)
const match = /^repos\/example\/repo\/issues\/(\d+)\/comments\?per_page=100&page=(\d+)$/.exec(args[1] || '')
if (args[0] !== 'api' || !match) {
  process.stderr.write('unexpected gh arguments: ' + JSON.stringify(args))
  process.exit(2)
}
const number = Number(match[1]), page = Number(match[2])
const pair = number <= 102 ? 'first' : 'second'
const partner = number % 2 ? number + 1 : number - 1
const marker = (name) => path.join(dir, name)
const log = (event) => fs.appendFileSync(marker('events'), JSON.stringify(event) + '\n')
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
const deadline = Date.now() + 3000
const waitFor = (condition) => {
  while (!condition()) {
    if (Date.now() >= deadline) return false
    pause()
  }
  return true
}
log({ kind: 'start', number, page, cwd: process.cwd() })
if (page === 1 && number <= 104) {
  fs.writeFileSync(marker('active-' + number), '')
  if (fs.existsSync(marker('active-' + partner))) fs.writeFileSync(marker('release-' + pair), '')
  if (!waitFor(() => fs.existsSync(marker('release-' + pair)))) {
    fs.rmSync(marker('active-' + number), { force: true })
    log({ kind: 'end', number, page, barrierFailed: true })
    process.stderr.write('composed history overlap barrier expired for ' + number)
    process.exit(3)
  }
  if (process.env.COMPOSED_HISTORY_TEST_FAILURE === '1' && number === 103 &&
      !waitFor(() => fs.existsSync(marker('done-104')))) {
    fs.rmSync(marker('active-' + number), { force: true })
    log({ kind: 'end', number, page, barrierFailed: true })
    process.stderr.write('reverse completion barrier expired')
    process.exit(4)
  }
  fs.rmSync(marker('active-' + number), { force: true })
}
log({ kind: 'end', number, page })
fs.writeFileSync(marker('done-' + number), '')
if (process.env.COMPOSED_HISTORY_TEST_FAILURE === '1' && page === 1 && number >= 103 && number <= 104) {
  process.stderr.write('deliberate failure for ' + number)
  process.exit(5)
}
const comments = page === 1 ? Array.from({ length: 100 }, (_, i) => ({
  id: number * 1000 + i, user: { login: 'operator' }, body: 'ordinary comment',
  created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z',
})) : []
process.stdout.write(JSON.stringify(comments))
`

type Event = { kind: 'start' | 'end'; number: number; page: number; cwd?: string; barrierFailed?: boolean }
let directory: string | undefined

afterEach(() => {
  vi.unstubAllEnvs()
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function setup(failure: boolean) {
  directory = mkdtempSync(join(tmpdir(), 'composed-history-overlap-'))
  const executable = join(directory, 'gh')
  writeFileSync(executable, fakeGh)
  chmodSync(executable, 0o755)
  vi.stubEnv('PATH', `${directory}${delimiter}${process.env.PATH ?? ''}`)
  vi.stubEnv('COMPOSED_HISTORY_TEST_DIR', directory)
  vi.stubEnv('COMPOSED_HISTORY_TEST_FAILURE', failure ? '1' : '0')
  return { cwd: directory, readAuthor: 'operator' }
}

function events(cwd: string): Event[] {
  const file = join(cwd, 'events')
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Event)
    : []
}

function expectJoinedAndBounded(observed: Event[], cwd: string) {
  let active = 0
  let maximum = 0
  for (const event of observed) {
    if (event.kind === 'start') {
      expect(event.cwd).toBe(cwd)
      active += 1
      maximum = Math.max(maximum, active)
    } else {
      expect(event.barrierFailed).not.toBe(true)
      active -= 1
      expect(active).toBeGreaterThanOrEqual(0)
    }
  }
  expect(maximum).toBe(2)
  expect(active).toBe(0)
}

const scopes = [101, 102, 103, 104, 105].map((number) => githubScope('example/repo', number))

it('overlaps adjacent composed histories and fully paginates in scope order', async () => {
  const options = setup(false)
  const result = await readComposedWorkflowHistory(scopes.slice(0, 4), options)
  const observed = events(options.cwd)
  expect(result.ok, `result: ${JSON.stringify(result)}; native events: ${JSON.stringify(observed)}`).toBe(true)
  if (!result.ok) throw new Error('expected complete composed history')
  expect(result.scopes).toEqual(scopes.slice(0, 4))
  expect(result.histories.map((history) => history.source.scope)).toEqual(scopes.slice(0, 4))
  expect(result.histories.map((history) => history.source.comments.length)).toEqual([100, 100, 100, 100])
  expect(result.records).toEqual([])
  expectJoinedAndBounded(observed, options.cwd)
  expect(
    observed
      .filter((event) => event.kind === 'start')
      .map(({ number, page }) => `${number}:${page}`)
      .sort(),
  ).toEqual(['101:1', '101:2', '102:1', '102:2', '103:1', '103:2', '104:1', '104:2'])
})

it('joins the failing pair and keeps the successful prefix and first input error', async () => {
  const options = setup(true)
  const result = await readComposedWorkflowHistory(scopes, options)
  const observed = events(options.cwd)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected unreadable composed history')
  expect(result.reason).toBe('unreadable')
  expect(JSON.stringify(result.diagnostics)).toContain('deliberate failure for 103')
  expect(result.histories.map((history) => history.source.scope)).toEqual(scopes.slice(0, 2))
  expect(result.histories.map((history) => history.source.comments.length)).toEqual([100, 100])
  expect(result.evidence).toBeUndefined()
  expectJoinedAndBounded(observed, options.cwd)
  expect(observed.findIndex((event) => event.kind === 'end' && event.number === 104)).toBeLessThan(
    observed.findIndex((event) => event.kind === 'end' && event.number === 103),
  )
  expect(
    observed
      .filter((event) => event.kind === 'start')
      .map(({ number, page }) => `${number}:${page}`)
      .sort(),
  ).toEqual(['101:1', '101:2', '102:1', '102:2', '103:1', '104:1', '105:1', '105:2'])
})

it('refuses empty or duplicate scopes before invoking gh', async () => {
  const options = setup(false)
  const empty = await readComposedWorkflowHistory([], options)
  const duplicate = await readComposedWorkflowHistory([scopes[0], scopes[0]], options)
  expect(empty).toMatchObject({ ok: false, reason: 'incomplete', histories: [] })
  expect(duplicate).toMatchObject({ ok: false, reason: 'ambiguous', histories: [] })
  expect(events(options.cwd)).toEqual([])
})
