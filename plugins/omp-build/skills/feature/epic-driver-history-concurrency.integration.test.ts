import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

// Each native comment request records its entry and exit. Page-one partners must
// both enter before either can return; the finite deadline also makes the old
// synchronous transport refuse instead of hanging the test process.
const fakeGh = String.raw`#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const dir = process.env.HISTORY_TEST_DIR
const args = process.argv.slice(2)
const log = (event) => fs.appendFileSync(path.join(dir, 'events'), JSON.stringify(event) + '\n')
if (args[0] === 'api' && args[1] === 'user') {
  log({ kind: 'viewer' })
  process.stdout.write('operator\n')
  process.exit(0)
}
const match = /^repos\/example\/repo\/issues\/(\d+)\/comments\?per_page=100&page=(\d+)$/.exec(args[1] || '')
if (args[0] !== 'api' || !match) {
  process.stderr.write('unexpected gh arguments: ' + JSON.stringify(args))
  process.exit(2)
}
const number = Number(match[1]), page = Number(match[2])
const pair = number <= 102 ? 'first' : 'second'
const partner = number % 2 ? number + 1 : number - 1
const marker = (name) => path.join(dir, name)
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
const deadline = Date.now() + 3000
const waitFor = (condition) => {
  while (!condition()) {
    if (Date.now() >= deadline) return false
    pause()
  }
  return true
}
log({ kind: 'start', number, page, cwd: process.cwd(), redirected: Boolean(process.env.GIT_DIR) })
if (page === 1) {
  fs.writeFileSync(marker('active-' + number), '')
  if (fs.existsSync(marker('active-' + partner))) fs.writeFileSync(marker('release-' + pair), '')
  if (!waitFor(() => fs.existsSync(marker('release-' + pair)))) {
    fs.rmSync(marker('active-' + number), { force: true })
    log({ kind: 'end', number, page, barrierFailed: true })
    process.stderr.write('history overlap barrier expired for ' + number)
    process.exit(3)
  }
  if (process.env.HISTORY_TEST_FAILURE === '1' && number === 101 &&
      !waitFor(() => fs.existsSync(marker('done-102')))) {
    fs.rmSync(marker('active-' + number), { force: true })
    log({ kind: 'end', number, page, barrierFailed: true })
    process.stderr.write('reverse completion barrier expired')
    process.exit(4)
  }
  fs.rmSync(marker('active-' + number), { force: true })
}
log({ kind: 'end', number, page })
fs.writeFileSync(marker('done-' + number), '')
if (process.env.HISTORY_TEST_FAILURE === '1' && page === 1 && number <= 102) {
  process.stderr.write('deliberate failure for ' + number)
  process.exit(5)
}
const comments = page === 1 ? Array.from({ length: 100 }, (_, i) => ({
  id: number * 1000 + i, user: { login: 'operator' }, body: 'ordinary comment',
  created_at: '2026-10-21T00:00:00Z', updated_at: '2026-10-21T00:00:00Z',
})) : []
process.stdout.write(JSON.stringify(comments))
`

type Event = {
  kind: 'viewer' | 'start' | 'end'
  number?: number
  page?: number
  cwd?: string
  redirected?: boolean
  barrierFailed?: boolean
}

let directory: string | undefined

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

async function setup(failure: boolean) {
  directory = mkdtempSync(join(tmpdir(), 'epic-history-overlap-'))
  const executable = join(directory, 'gh')
  writeFileSync(executable, fakeGh)
  chmodSync(executable, 0o755)
  vi.stubEnv('PATH', `${directory}${delimiter}${process.env.PATH ?? ''}`)
  vi.stubEnv('HISTORY_TEST_DIR', directory)
  vi.stubEnv('HISTORY_TEST_FAILURE', failure ? '1' : '0')
  vi.stubEnv('GIT_DIR', '/must-not-reach-gh')
  // Reload the module so its cached viewer cannot leak across tests.
  vi.resetModules()
  const { stoppedReviews } = await import('./epic-driver-github')
  return { stoppedReviews, repo: directory }
}

function events(repo: string): Event[] {
  return readFileSync(join(repo, 'events'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Event)
}

function expectJoinedAndBounded(observed: Event[], repo: string) {
  let active = 0
  let maximum = 0
  for (const event of observed) {
    if (event.kind === 'start') {
      expect(event.cwd).toBe(repo)
      expect(event.redirected).toBe(false)
      active += 1
      maximum = Math.max(maximum, active)
    } else if (event.kind === 'end') {
      expect(event.barrierFailed).not.toBe(true)
      active -= 1
      expect(active).toBeGreaterThanOrEqual(0)
    }
  }
  expect(maximum).toBe(2)
  expect(active).toBe(0)
  expect(observed.filter((event) => event.kind === 'viewer')).toHaveLength(1)
}

it('overlaps adjacent native review histories, drains every page, and joins all reads', async () => {
  const { stoppedReviews, repo } = await setup(false)
  let result: Set<number> | undefined
  let failure: unknown
  try {
    result = await stoppedReviews(repo, 'example/repo', [101, 102, 103, 104])
  } catch (error) {
    failure = error
  }
  const observed = existsSync(join(repo, 'events')) ? events(repo) : []
  const errorDetails =
    failure instanceof Error
      ? { name: failure.name, message: failure.message, serialized: JSON.stringify(failure) }
      : failure
  expect(
    failure,
    `history read failure: ${JSON.stringify(errorDetails)}; native events: ${JSON.stringify(observed)}`,
  ).toBeUndefined()
  if (result === undefined) throw new Error('review histories returned no result')
  expect([...result]).toEqual([])
  expectJoinedAndBounded(observed, repo)
  expect(
    observed
      .filter((event) => event.kind === 'start')
      .map(({ number, page }) => `${number}:${page}`)
      .sort(),
  ).toEqual(['101:1', '101:2', '102:1', '102:2', '103:1', '103:2', '104:1', '104:2'])
})

it('joins all demanded histories and reports the first input failure despite reversed completion', async () => {
  const { stoppedReviews, repo } = await setup(true)
  let failure: unknown
  try {
    await stoppedReviews(repo, 'example/repo', [101, 102, 103, 104])
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  expect(JSON.stringify(failure)).toContain('deliberate failure for 101')
  const observed = events(repo)
  expectJoinedAndBounded(observed, repo)
  expect(observed.findIndex((event) => event.kind === 'end' && event.number === 102)).toBeLessThan(
    observed.findIndex((event) => event.kind === 'end' && event.number === 101),
  )
  expect(
    observed
      .filter((event) => event.kind === 'start')
      .map(({ number, page }) => `${number}:${page}`)
      .sort(),
  ).toEqual(['101:1', '102:1', '103:1', '103:2', '104:1', '104:2'])
})

it('keeps injected gh effects authoritative for review histories', async () => {
  const { stoppedReviews, repo } = await setup(false)
  // Use the same freshly loaded runtime instance as the driver under test.
  const { withEpicEffects } = await import('./epic-driver-runtime')
  const calls: string[] = []
  const result = await withEpicEffects(
    {
      gh: (cwd, args) => {
        expect(cwd).toBe(repo)
        calls.push(args.join(' '))
        if (args[1] === 'user') return ' operator \n'
        if (args[1]?.startsWith('repos/example/repo/issues/')) return ' [] \n'
        throw new Error(`unexpected injected gh arguments: ${args.join(' ')}`)
      },
    },
    () => stoppedReviews(repo, 'example/repo', [101, 102, 103]),
  )
  expect([...result]).toEqual([])
  expect(calls).toEqual([
    'api user --jq .login',
    'api repos/example/repo/issues/101/comments?per_page=100&page=1',
    'api repos/example/repo/issues/102/comments?per_page=100&page=1',
    'api repos/example/repo/issues/103/comments?per_page=100&page=1',
  ])
  expect(existsSync(join(repo, 'events'))).toBe(false)
})
