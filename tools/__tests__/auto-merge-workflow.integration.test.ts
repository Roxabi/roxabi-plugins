import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ARM = 'Enable auto-merge (merge commit)'
const DISARM = 'Disarm auto-merge on a moved head'
const CLEANUP = 'Disarm after failed arming'
const REPOSITORY = 'Roxabi/roxabi-plugins'
const PR = '42'
const HEAD = '0123456789abcdef0123456789abcdef01234567'
const BOT = 'dependabot[bot]'
const PATCH_ENV = { AUTHOR: BOT, DEPENDABOT_UPDATE_TYPE: 'version-update:semver-patch' }
const REVIEWED = { name: 'reviewed' }
const OTHER_LABEL = { name: 'documentation' }
const ARMED = { mergeMethod: 'MERGE' }
const SUCCESS_AND_PENDING = [
  { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' },
  { __typename: 'StatusContext', context: 'deployment', state: 'PENDING' },
]

interface WorkflowStep {
  name?: string
  env?: Record<string, string>
  run?: string
}

const workflow = load(readFileSync(new URL('../../.github/workflows/auto-merge.yml', import.meta.url), 'utf8')) as {
  jobs: { 'auto-merge': { steps: WorkflowStep[] } }
}

interface CommandResult {
  code: number
  stderr: string
}

interface Scenario {
  commits?: { authors: { login: string }[] }[]
  statusCheckRollup?: Record<string, string>[]
  autoMergeRequest?: typeof ARMED | null
  labels?: { name: string }[]
  arm?: CommandResult[]
  disable?: CommandResult
  removeLabel?: CommandResult
}

// Only gh is a test double: Bash and jq run the expressions from the workflow.
const fakeGh = String.raw`#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')

const args = process.argv.slice(2)
const entry = JSON.stringify(args)
const log = 'gh.jsonl'
const previousCalls = readFileSync(log, 'utf8').split('\n')
appendFileSync(log, entry + '\n')
const scenario = JSON.parse(readFileSync('scenario.json', 'utf8'))
const [resource, action, pr, ...options] = args
const repo = '--repo ' + process.env.GITHUB_REPOSITORY
const shape = action + ' ' + options.join(' ')
const state = { autoMergeRequest: scenario.autoMergeRequest ?? null }

function reply(result) {
  if (!result) return
  process.stderr.write(result.stderr + '\n')
  process.exitCode = result.code
}

function run() {
  if (resource !== 'pr' || pr !== process.env.PR_NUMBER) return false
  switch (shape) {
    case 'view ' + repo + ' --json commits':
      return { commits: scenario.commits ?? [] }
    case 'view ' + repo + ' --json statusCheckRollup':
      return { statusCheckRollup: scenario.statusCheckRollup }
    case 'view ' + repo + ' --json autoMergeRequest,labels':
      return { ...state, labels: scenario.labels ?? [] }
    case 'view ' + repo + ' --json autoMergeRequest':
      return state
    case 'view ' + repo + ' --json autoMergeRequest --jq ' + options.at(-1): {
      const result = spawnSync('jq', [options.at(-1)], {
        input: JSON.stringify(state),
        stdio: ['pipe', 'inherit', 'inherit'],
      })
      if (result.error) throw result.error
      process.exitCode = result.status ?? 2
      return
    }
    case 'merge --auto --merge ' + repo + ' --match-head-commit ' + process.env.HEAD_SHA:
      reply(scenario.arm?.[previousCalls.filter(line => line === entry).length])
      return
    case 'merge ' + repo + ' --disable-auto':
      reply(scenario.disable)
      return
    case 'edit ' + repo + ' --remove-label reviewed':
      reply(scenario.removeLabel)
      return
    default:
      return false
  }
}

const payload = run()
if (payload === false) {
  process.stderr.write('unexpected gh call: ' + entry + '\n')
  process.exitCode = 2
} else if (payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}
`

const VIEW_COMMITS = ['pr', 'view', PR, '--repo', REPOSITORY, '--json', 'commits']
const VIEW_CHECKS = ['pr', 'view', PR, '--repo', REPOSITORY, '--json', 'statusCheckRollup']
const ENABLE = ['pr', 'merge', PR, '--auto', '--merge', '--repo', REPOSITORY, '--match-head-commit', HEAD]
const DISABLE = ['pr', 'merge', PR, '--repo', REPOSITORY, '--disable-auto']
const REMOVE_LABEL = ['pr', 'edit', PR, '--repo', REPOSITORY, '--remove-label', 'reviewed']
const VIEW_ARMED = ['pr', 'view', PR, '--repo', REPOSITORY, '--json', 'autoMergeRequest', '--jq', '.autoMergeRequest']
const VIEW_CLEANUP = ['pr', 'view', PR, '--repo', REPOSITORY, '--json', 'autoMergeRequest,labels']

let scratch: string
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'auto-merge-workflow-'))
  writeFileSync(join(scratch, 'gh'), fakeGh, { mode: 0o700 })
})
afterEach(() => rmSync(scratch, { recursive: true, force: true }))

interface StepResult {
  status: number | null
  output: string
  errors: string[]
  calls: string[][]
}

function runStep(name: string, scenario: Scenario = {}, overrides: Record<string, string> = {}): StepResult {
  const step = workflow.jobs['auto-merge'].steps.find((candidate) => candidate.name === name)
  if (!step?.run || !step.env) throw new Error(`Missing run script or env for step: ${name}`)
  const values: Record<string, string> = {
    GH_TOKEN: '',
    PR_NUMBER: PR,
    HEAD_SHA: HEAD,
    BASE_REF: 'main',
    DEFAULT_BRANCH: 'main',
    AUTHOR: 'contributor',
    DEPENDABOT_UPDATE_TYPE: '',
    PR_AUTO_MERGE: 'null',
    PR_LABELS: '[]',
    ...overrides,
  }
  const env: NodeJS.ProcessEnv = {
    GITHUB_REPOSITORY: REPOSITORY,
    PATH: [scratch, process.env.PATH].join(delimiter),
  }
  for (const key of Object.keys(step.env)) {
    const value = values[key]
    if (value === undefined) throw new Error(`Missing fixture env value for ${name}: ${key}`)
    env[key] = value
  }
  writeFileSync(join(scratch, 'step.sh'), step.run)
  writeFileSync(join(scratch, 'scenario.json'), JSON.stringify({ statusCheckRollup: SUCCESS_AND_PENDING, ...scenario }))
  writeFileSync(join(scratch, 'gh.jsonl'), '')

  const result = spawnSync('bash', ['-e', '-o', 'pipefail', 'step.sh'], {
    cwd: scratch,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  if (result.error) throw result.error
  const output = `${result.stdout}\n${result.stderr}`
  const calls = readFileSync(join(scratch, 'gh.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return {
    status: result.status,
    output,
    errors: output.split('\n').filter((line) => line.startsWith('::error::')),
    calls,
  }
}

function expectStep(result: StepResult, status: number, errors: string[], calls: string[][]) {
  expect(result.status, result.output).toBe(status)
  expect(result.errors, result.output).toEqual(errors.map((error) => `::error::${error}`))
  expect(result.calls).toEqual(calls)
}

function eventState(autoMerge: typeof ARMED | null, labels: { name: string }[]) {
  return { PR_AUTO_MERGE: JSON.stringify(autoMerge), PR_LABELS: JSON.stringify(labels) }
}

describe(ARM, () => {
  it('arms a PR into the default branch with successful and pending checks', () => {
    expectStep(runStep(ARM), 0, [], [VIEW_CHECKS, ENABLE])
  })

  it('refuses a PR into a non-default branch before calling gh', () => {
    expectStep(runStep(ARM, {}, { BASE_REF: 'release' }), 1, ['refusing auto-merge: PR targets release, not main'], [])
  })

  it.each([
    { name: 'trufflehog', check: { __typename: 'CheckRun', name: 'trufflehog', conclusion: 'FAILURE' } },
    { name: 'external-ci', check: { __typename: 'StatusContext', context: 'external-ci', state: 'ERROR' } },
  ])('refuses when the $name check failed', ({ name, check }) => {
    expectStep(
      runStep(ARM, { statusCheckRollup: [...SUCCESS_AND_PENDING, check] }),
      1,
      [`refusing auto-merge: failed checks on the head: ${name}`],
      [VIEW_CHECKS],
    )
  })

  it('arms with skipped, neutral, successful and pending checks', () => {
    expectStep(
      runStep(ARM, {
        statusCheckRollup: [
          ...SUCCESS_AND_PENDING,
          { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
          { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'NEUTRAL' },
          { __typename: 'CheckRun', name: 'tests', status: 'IN_PROGRESS', conclusion: '' },
        ],
      }),
      0,
      [],
      [VIEW_CHECKS, ENABLE],
    )
  })

  const botCommit = { authors: [{ login: BOT }] }
  it.each(['version-update:semver-patch', 'version-update:semver-minor'])(
    'arms a %s Dependabot PR when every author is the bot',
    (updateType) => {
      const commits = [botCommit, { authors: [{ login: BOT }, { login: BOT }] }]
      expectStep(
        runStep(ARM, { commits }, { ...PATCH_ENV, DEPENDABOT_UPDATE_TYPE: updateType }),
        0,
        [],
        [VIEW_COMMITS, VIEW_CHECKS, ENABLE],
      )
    },
  )

  it.each([
    { reason: 'a human co-author', commits: [botCommit, { authors: [{ login: BOT }, { login: 'contributor' }] }] },
    { reason: 'no commits', commits: [] },
    { reason: 'a commit without authors', commits: [botCommit, { authors: [] }] },
  ])('refuses a Dependabot patch with $reason', ({ commits }) => {
    expectStep(
      runStep(ARM, { commits }, PATCH_ENV),
      1,
      ['refusing auto-merge: Dependabot PR has a non-Dependabot commit author'],
      [VIEW_COMMITS],
    )
  })

  it.each(['version-update:semver-major', ''])('refuses a Dependabot update of type %j before calling gh', (type) => {
    expectStep(
      runStep(ARM, {}, { ...PATCH_ENV, DEPENDABOT_UPDATE_TYPE: type }),
      1,
      ['refusing auto-merge: Dependabot update is not semver-minor or semver-patch'],
      [],
    )
  })

  it.each(['0123456', `g${HEAD.slice(1)}`])('refuses an invalid reviewed head SHA %s', (sha) => {
    expectStep(
      runStep(ARM, {}, { HEAD_SHA: sha }),
      1,
      ['refusing auto-merge without the reviewed commit'],
      [VIEW_CHECKS],
    )
  })

  it('disables and re-arms against the reviewed head when auto-merge was already enabled', () => {
    expectStep(
      runStep(ARM, { arm: [{ code: 1, stderr: 'auto-merge already enabled' }] }),
      0,
      [],
      [VIEW_CHECKS, ENABLE, DISABLE, ENABLE],
    )
  })

  it('refuses when re-arming fails after disabling auto-merge', () => {
    expectStep(
      runStep(ARM, {
        arm: [
          { code: 1, stderr: 'auto-merge already enabled' },
          { code: 1, stderr: 'head SHA does not match' },
        ],
      }),
      1,
      ['refusing to enable auto-merge without the reviewed commit'],
      [VIEW_CHECKS, ENABLE, DISABLE, ENABLE],
    )
  })

  it('refuses another arm failure without attempting to disable or re-arm', () => {
    expectStep(
      runStep(ARM, { arm: [{ code: 1, stderr: 'head SHA does not match' }] }),
      1,
      ['refusing to enable auto-merge without the reviewed commit'],
      [VIEW_CHECKS, ENABLE],
    )
  })
})

describe(DISARM, () => {
  it.each([
    { reason: 'armed and reviewed', autoMerge: ARMED, labels: [REVIEWED], calls: [DISABLE, REMOVE_LABEL, VIEW_ARMED] },
    { reason: 'only armed', autoMerge: ARMED, labels: [OTHER_LABEL], calls: [DISABLE, VIEW_ARMED] },
    { reason: 'only reviewed', autoMerge: null, labels: [REVIEWED], calls: [DISABLE, REMOVE_LABEL, VIEW_ARMED] },
  ])('disarms a moved head that was $reason and stops the run', ({ autoMerge, labels, calls }) => {
    expectStep(
      runStep(DISARM, {}, eventState(autoMerge, labels)),
      1,
      ['head moved after review — auto-merge disarmed'],
      calls,
    )
  })

  it('succeeds when the moved head was neither armed nor reviewed', () => {
    expectStep(runStep(DISARM, {}, eventState(null, [OTHER_LABEL])), 0, [], [DISABLE, VIEW_ARMED])
  })

  it.each(['auto-merge not enabled', "Can't disable auto-merge on a draft pull request"])(
    'continues to label removal and readback when disable reports %j',
    (stderr) => {
      expectStep(
        runStep(DISARM, { disable: { code: 1, stderr } }, eventState(null, [REVIEWED])),
        1,
        ['head moved after review — auto-merge disarmed'],
        [DISABLE, REMOVE_LABEL, VIEW_ARMED],
      )
    },
  )

  it('fails immediately on another disable error', () => {
    expectStep(
      runStep(
        DISARM,
        { disable: { code: 1, stderr: 'Resource not accessible by integration' } },
        eventState(ARMED, [REVIEWED]),
      ),
      1,
      ['failed to disable auto-merge'],
      [DISABLE],
    )
  })

  it('fails if the follow-up read still shows auto-merge armed', () => {
    expectStep(
      runStep(DISARM, { autoMergeRequest: ARMED }, eventState(ARMED, [REVIEWED])),
      1,
      ['auto-merge still armed after disarm'],
      [DISABLE, REMOVE_LABEL, VIEW_ARMED],
    )
  })
})

describe(CLEANUP, () => {
  const calls = [DISABLE, REMOVE_LABEL, VIEW_CLEANUP]

  it('disables auto-merge, removes reviewed and succeeds on a clean readback', () => {
    expectStep(runStep(CLEANUP, { labels: [OTHER_LABEL] }), 0, [], calls)
  })

  it.each([
    { reason: 'reviewed', autoMergeRequest: null, labels: [REVIEWED] },
    { reason: 'armed', autoMergeRequest: ARMED, labels: [] },
  ])('fails if the readback shows the PR is still $reason', ({ autoMergeRequest, labels }) => {
    const state = { autoMergeRequest, labels }
    expectStep(runStep(CLEANUP, state), 1, [`auto-merge cleanup remainder: ${JSON.stringify(state)}`], calls)
  })

  it('reads back state and reports both errors even if both writes fail', () => {
    expectStep(
      runStep(CLEANUP, {
        disable: { code: 1, stderr: 'cannot disable' },
        removeLabel: { code: 1, stderr: 'cannot remove label' },
      }),
      1,
      ['failed to disable native auto-merge: cannot disable', 'failed to remove reviewed label: cannot remove label'],
      calls,
    )
  })
})
