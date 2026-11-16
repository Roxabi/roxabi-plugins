import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePublishBinding } from './fix-entry-target-binding.ts'

const boxes: string[] = []
const exec = promisify(execFile)

afterEach(() => {
  for (const box of boxes.splice(0)) rmSync(box, { recursive: true, force: true })
})

// An external GitHub transport fixture: its responses are synthetic API data,
// not a GitHub authentication or authorization grant.
const transport = `
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const args = process.argv.slice(3)
let response
if (args[0] === 'repo' && args[1] === 'view' && args[3] === '--json') {
  if (args[2] === 'Acme/App') response = state.base
  else if (args[2] === state.remote) response = state.head
} else if (args[0] === 'pr' && args[1] === 'view' && args[2] === '7' && args[3] === '--json') {
  response = state.pr
}
if (!response) { console.error('unrecognized fixture request'); process.exit(1) }
process.stdout.write(JSON.stringify(response))
`

function setup(baseUrl: string | null, headUrl: string | null) {
  const box = mkdtempSync(join(tmpdir(), 'fix-destination-binding-'))
  boxes.push(box)
  const cwd = join(box, 'work')
  const remote = join(box, 'publication.git')
  const script = join(box, 'github-transport.cjs')
  const state = join(box, 'github-state.json')
  mkdirSync(cwd)
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  Object.assign(env, { HOME: box, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
  const git = (directory: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: directory,
      env,
      encoding: 'utf8',
    }).trim()
  git(box, 'init', '--bare', remote)
  git(cwd, 'init', '-b', 'Fix/Mixed-Case')
  git(cwd, 'config', 'user.email', 'test@example.com')
  git(cwd, 'config', 'user.name', 'Test')
  git(cwd, 'commit', '--allow-empty', '-m', 'initial')
  git(cwd, 'remote', 'add', 'origin', remote)
  git(cwd, 'push', 'origin', 'HEAD:refs/heads/Fix/Mixed-Case')
  const head = git(cwd, 'rev-parse', 'HEAD')
  writeFileSync(script, transport)
  writeFileSync(
    state,
    JSON.stringify({
      remote,
      base: {
        nameWithOwner: 'Acme/App',
        defaultBranchRef: { name: 'main' },
        ...(baseUrl === null ? {} : { url: baseUrl }),
      },
      head: {
        nameWithOwner: 'Fork/App',
        defaultBranchRef: { name: 'main' },
        ...(headUrl === null ? {} : { url: headUrl }),
      },
      pr: {
        state: 'OPEN',
        headRefOid: head,
        headRefName: 'Fix/Mixed-Case',
        headRepository: { nameWithOwner: 'Fork/App' },
        baseRefName: 'main',
      },
    }),
  )
  const gh = async (directory: string, args: string[]) =>
    (await exec(process.execPath, [script, state, ...args], { cwd: directory, encoding: 'utf8' })).stdout.trim()
  const resolve = () =>
    resolvePublishBinding(cwd, gh, 'Acme/App', {
      repository: 'Acme/App',
      target: 'Acme/App#7',
      number: 7,
      kind: 'pull-request',
      state: 'open',
      candidateGitSHA: head,
      baseGitSHA: head,
    })
  return { cwd, remote, git, resolve }
}

describe('authenticated correction destination', () => {
  it('uses canonical API authority and fork head identity for equivalent Git transport spellings', async () => {
    const fixture = setup('https://forge.example.test:8443/Acme/App', 'https://forge.example.test:8443/Fork/App')
    const spellings = ['git@alias.example:Fork/App.git', 'https://alias.example/Fork/App.git']
    for (const spelling of spellings) {
      fixture.git(fixture.cwd, 'config', '--add', `url.${fixture.remote}.insteadOf`, spelling)
      fixture.git(fixture.cwd, 'remote', 'set-url', 'origin', spelling)
      const result = await fixture.resolve()
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.diagnostics.join(', '))
      expect(result.value).toMatchObject({
        destination: {
          authority: 'forge.example.test:8443',
          publicationRepository: 'Fork/App',
          destinationRef: 'refs/heads/Fix/Mixed-Case',
        },
      })
    }
  })

  it.each([
    ['missing base canonical URL', null, 'https://forge.example.test:8443/Fork/App'],
    ['missing head canonical URL', 'https://forge.example.test:8443/Acme/App', null],
    [
      'different hosting authority',
      'https://forge.example.test:8443/Acme/App',
      'https://other.example.test:8443/Fork/App',
    ],
  ])('refuses %s', async (_case, baseUrl, headUrl) => {
    const result = await setup(baseUrl, headUrl).resolve()
    expect(result.ok).toBe(false)
  })
})
