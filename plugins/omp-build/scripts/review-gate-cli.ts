import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import type { Gh, Git } from '../skills/feature/review-base.ts'

export type Arguments = {
  repository: string
  pr: number
  head: string
  automationLogin: string
  candidateCwd: string
  toolingSha: string
}

export type CommandResult = { code: number; stdout: string; stderr: string }
export type MachineResult =
  | { ok: true; allowed: true; reviews: number; ci: 'green' | 'red' | 'pending' | 'unknown' }
  | { ok: false; allowed: false; reason: string; detail?: unknown }

const SHA = /^[0-9a-f]{40}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:_[A-Za-z0-9]+)?(?:\[bot\])?$/
const CI_WATCH = 'plugins/omp-build/skills/ci-watch/ci-watch.sh'
const TAXONOMY = 'plugins/omp-build/skills/dev-review/review-classes.yml'

export function output(result: MachineResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function usage(): never {
  throw new Error('usage: --repository --pr --head --automation-login --candidate-cwd --tooling-sha')
}

export function parseArguments(argv: string[]): Arguments {
  const values: Record<string, string | undefined> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined || values[flag] !== undefined) usage()
    values[flag] = value
  }
  const repository = values['--repository'] ?? ''
  const pr = Number(values['--pr'])
  const head = values['--head'] ?? ''
  const automationLogin = values['--automation-login'] ?? ''
  const candidateCwd = values['--candidate-cwd'] ?? ''
  const toolingSha = values['--tooling-sha'] ?? ''
  if (
    !REPOSITORY.test(repository) ||
    !Number.isSafeInteger(pr) ||
    pr < 1 ||
    !SHA.test(head) ||
    !LOGIN.test(automationLogin)
  )
    usage()
  if (!isAbsolute(candidateCwd) || !SHA.test(toolingSha)) usage()
  return { repository, pr, head, automationLogin, candidateCwd, toolingSha }
}

export function jsonDetail(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

export function trustedEnvironment(): Record<string, string | undefined> {
  const environment = { ...process.env }
  for (const name of [
    'BUN_OPTIONS',
    'BUN_PRELOAD',
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_INDEX_FILE',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
  ])
    delete environment[name]
  environment.GIT_CONFIG_GLOBAL = '/dev/null'
  environment.GIT_CONFIG_NOSYSTEM = '1'
  return environment
}

export function gitFetchEnvironment(): Record<string, string | undefined> {
  const environment = trustedEnvironment()
  if (environment.GIT_CONFIG_COUNT) return environment
  const token = environment.GH_TOKEN ?? environment.GITHUB_TOKEN
  if (!token) return environment
  environment.GIT_CONFIG_COUNT = '1'
  environment.GIT_CONFIG_KEY_0 = 'credential.helper'
  environment.GIT_CONFIG_VALUE_0 = '!gh auth git-credential'
  return environment
}

export async function command(
  cwd: string,
  argv: string[],
  input?: string,
  env = trustedEnvironment(),
): Promise<CommandResult> {
  const child = Bun.spawn(argv, {
    cwd,
    env,
    stdin: input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (input !== undefined) {
    if (child.stdin === undefined) throw new Error('command stdin is unavailable')
    child.stdin.write(input)
    child.stdin.end()
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

export function commandError(argv: readonly string[], result: CommandResult): Error {
  return new Error(
    `${argv.join(' ')} failed (${result.code}): ${(result.stderr || result.stdout).trim() || '(no output)'}`,
  )
}

export async function requiredCommand(cwd: string, argv: string[], input?: string): Promise<string> {
  const result = await command(cwd, argv, input)
  if (result.code !== 0) throw commandError(argv, result)
  return result.stdout
}

export function canonicalTaxonomy(toolingRoot: string): string[] {
  const text = readFileSync(join(toolingRoot, TAXONOMY), 'utf8')
  const classes = [...text.matchAll(/^\s*-\s+class:\s*([a-z][a-z0-9-]*)\s*$/gm)].map((match) => match[1])
  if (classes.length === 0 || new Set(classes).size !== classes.length)
    throw new Error('trusted review taxonomy is unreadable')
  return classes
}

export async function trustedRoot(expectedSha: string): Promise<string> {
  const root = realpathSync(resolve(import.meta.dirname, '../../..'))
  const actualSha = (await requiredCommand(root, ['git', '-C', root, 'rev-parse', 'HEAD'])).trim()
  if (actualSha !== expectedSha) throw new Error('trusted tooling checkout does not match --tooling-sha')
  const origin = (await requiredCommand(root, ['git', '-C', root, 'remote', 'get-url', 'origin'])).trim()
  if (origin !== 'https://github.com/Roxabi/roxabi-plugins')
    throw new Error('trusted tooling checkout has an unexpected origin')
  return root
}

export function scopedGh(toolingRoot: string, repository: string): Gh {
  return async (_cwd, commandArgs) => {
    const targetArgs =
      commandArgs[0] === 'pr'
        ? [...commandArgs, '--repo', repository]
        : commandArgs[0] === 'repo' && commandArgs[1] === 'view' && commandArgs[2]?.startsWith('--')
          ? ['repo', 'view', repository, ...commandArgs.slice(2)]
          : commandArgs
    const result = await command(toolingRoot, ['gh', ...targetArgs])
    if (result.code !== 0) throw commandError(['gh', ...targetArgs], result)
    return result.stdout.trim()
  }
}

export function scopedGit(candidateCwd: string): Git {
  const canonicalCandidate = realpathSync(candidateCwd)
  return async (cwd, commandArgs) => {
    if (realpathSync(cwd) !== canonicalCandidate)
      throw new Error('proof admission requested a Git directory other than --candidate-cwd')
    return command(
      canonicalCandidate,
      ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', canonicalCandidate, ...commandArgs],
      undefined,
      gitFetchEnvironment(),
    )
  }
}

export async function ciState(
  toolingRoot: string,
  gh: Gh,
  pr: number,
): Promise<'green' | 'red' | 'pending' | 'unknown'> {
  const rollup = await gh(toolingRoot, ['pr', 'view', String(pr), '--json', 'statusCheckRollup'])
  const normalized = await requiredCommand(toolingRoot, ['bash', join(toolingRoot, CI_WATCH), '--checks-of'], rollup)
  const classification = (
    await requiredCommand(toolingRoot, ['bash', join(toolingRoot, CI_WATCH), '--classify-checks'], normalized)
  ).trim()
  if (classification === 'GREEN') return 'green'
  if (classification === 'FAIL') return 'red'
  if (classification === 'PENDING') return 'pending'
  return 'unknown'
}
