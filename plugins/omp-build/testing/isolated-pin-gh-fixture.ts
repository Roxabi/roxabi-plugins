#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PIN_VECTOR_LIMIT, pinVectorQuery } from '../host/preparation-graphql.cjs'
import { executeSimCommand } from '../skills/feature/testing/gh-simulator/sim-execution.ts'

const args = process.argv.slice(2)
const source = 'Roxabi/roxabi-plugins'
const { GH_SIM_STATE, PIN_CANDIDATE, PIN_DEFAULT_HEAD, PIN_SHARED } = process.env
if (!GH_SIM_STATE || !PIN_CANDIDATE || !PIN_DEFAULT_HEAD || !PIN_SHARED)
  throw new Error('isolated-pin-gh-fixture-environment-missing')
const repo = join(GH_SIM_STATE.replace(/\/[^/]+$/, ''), 'omp-tooling.git')
const candidate = PIN_CANDIDATE
const defaultHead = PIN_DEFAULT_HEAD
const shared = PIN_SHARED
const flag = (name: string) => args[args.indexOf(name) + 1]
const controls = process.env.PIN_CONTROL_FILE
  ? (JSON.parse(readFileSync(process.env.PIN_CONTROL_FILE, 'utf8')) as {
      candidate?: string
      shared?: string
      target?: string
      comparison?: string
      requiredChecks?: string[]
    })
  : {}
const git = (...argv: string[]) => execFileSync('git', argv, { cwd: repo, encoding: 'utf8' }).trim()
const simulate = (readStdin = () => readFileSync(0, 'utf8')) =>
  executeSimCommand(args, { cwd: process.cwd(), readStdin })
if (
  process.env.PIN_FEATURE_GATE &&
  args[0] === 'variable' &&
  args[1] === 'get' &&
  args[2] === 'OMP_BUILD_TOOLING_SHA' &&
  flag('--repo') === source
) {
  writeFileSync(join(process.env.PIN_FEATURE_GATE, 'ready'), 'ready')
  readFileSync(join(process.env.PIN_FEATURE_GATE, 'release'))
}

if (args[0] === 'variable' && args[1] === 'get' && args[2] === 'OMP_BUILD_TOOLING_SHA') {
  const repository = flag('--repo')
  if (repository === source || repository === 'acme/app') {
    console.log(repository === source ? (controls.shared ?? shared) : (controls.candidate ?? candidate))
    process.exit(0)
  }
}
if (args[0] === 'api' && args[1] === 'graphql') {
  const expressions = args.filter((arg) => /^e[0-9]+=/.test(arg))
  if (
    args.includes('owner=Roxabi') &&
    args.includes('name=roxabi-plugins') &&
    expressions.length > 1 &&
    expressions.length <= PIN_VECTOR_LIMIT &&
    args.includes(`query=${pinVectorQuery(expressions.length)}`)
  ) {
    const repository: Record<string, { oid: string } | null> = {}
    for (const [index, field] of expressions.entries()) {
      const expression = field.slice(field.indexOf('=') + 1)
      try {
        const oid = git('rev-parse', '--verify', expression)
        repository[`f${index}`] = git('cat-file', '-t', oid) === 'blob' ? { oid } : null
      } catch {
        repository[`f${index}`] = null
      }
    }
    console.log(JSON.stringify({ data: { repository } }))
    process.exit(0)
  }
  const expression = args.find((arg) => arg.startsWith(`expression=${shared}:`))?.slice('expression='.length)
  if (expression) {
    console.log(JSON.stringify({ data: { repository: { object: { oid: git('rev-parse', expression) } } } }))
    process.exit(0)
  }
}
if (
  args[0] === 'api' &&
  args[1] === 'repos/acme/app/branches/main/protection/required_status_checks' &&
  controls.requiredChecks
) {
  console.log(JSON.stringify({ contexts: controls.requiredChecks }))
  process.exit(0)
}
if (args[0] === 'repo' && args[1] === 'view' && !args.includes(source) && controls.target) {
  console.log(JSON.stringify({ nameWithOwner: controls.target }))
  process.exit(0)
}
if (
  process.env.PIN_SYNC_DIR &&
  args[0] === 'api' &&
  args[1] === 'graphql' &&
  args.includes(`expression=${candidate}:plugins/omp-build/package.json`)
) {
  const countPath = join(process.env.PIN_SYNC_DIR, 'count')
  let count = 0
  try {
    count = Number(readFileSync(countPath, 'utf8'))
  } catch {}
  writeFileSync(countPath, String(++count))
  if (count === 2) {
    const response = simulate(() => '')
    if (response.status !== 0) {
      process.stderr.write(response.stderr)
      process.exit(response.status)
    }
    writeFileSync(join(process.env.PIN_SYNC_DIR, 'ready'), 'ready')
    readFileSync(join(process.env.PIN_SYNC_DIR, 'release'))
    process.stdout.write(response.stdout)
    process.exit(0)
  }
}
if (args[0] === 'api' && args[1] === `repos/${source}`) {
  console.log(JSON.stringify({ default_branch: 'main', full_name: source }))
  process.exit(0)
}
if (args[0] === 'repo' && args[1] === 'view' && args.includes(source)) {
  console.log(
    JSON.stringify({ nameWithOwner: source, defaultBranchRef: { name: 'main' }, url: `https://github.com/${source}` }),
  )
  process.exit(0)
}
if (args[0] === 'api' && args[1] === `repos/${source}/commits/main`) {
  console.log(JSON.stringify({ sha: defaultHead }))
  process.exit(0)
}
if (args[0] === 'api' && args[1] === `repos/${source}/git/ref/heads/main`) {
  console.log(JSON.stringify({ ref: 'refs/heads/main', object: { sha: defaultHead, type: 'commit' } }))
  process.exit(0)
}
if (args[0] === 'api' && args[1] === `repos/${source}/compare/${candidate}...${defaultHead}`) {
  console.log(
    JSON.stringify({
      status: controls.comparison ?? 'ahead',
      ahead_by: 1,
      behind_by: 0,
      base_commit: { sha: candidate },
      merge_base_commit: { sha: candidate },
    }),
  )
  process.exit(0)
}
const result = simulate()
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
if (result.status !== 0) process.exit(result.status)
