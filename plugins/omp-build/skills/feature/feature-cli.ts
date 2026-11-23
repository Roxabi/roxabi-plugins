import { defaultGh } from '../../roxabi/feature-engine.ts'
import { defaultGit } from '../../roxabi/workflow-checkout.ts'
import { act, type Input, messageOf, type Runtime, refusalReason, SHA } from './feature-effects.ts'

const USAGE = `Usage: bash <skill-dir>/trusted-bun.sh <skill-dir>/feature-cli.ts <command> --repo <owner/repo> --issue <N> --mandate <recordId> [args]
  push --tip <sha> [--from <sha>] [--pr <N>]
  open-pr --tip <sha>
  land --pr <N> --head <sha>
  finish --pr <N>`
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/
const POSITIVE = /^[1-9][0-9]*$/

const EFFECT_FLAGS = {
  push: ['tip', 'from', 'pr'],
  'open-pr': ['tip'],
  land: ['pr', 'head'],
  finish: ['pr'],
} as const

function readFlags(command: Input['command'], rest: readonly string[]): Map<string, string> {
  if (rest.length % 2 !== 0) throw new Error('invalid arguments')
  const args = new Map<string, string>()
  const allowed = new Set(['repo', 'issue', 'mandate', ...EFFECT_FLAGS[command]])
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]?.match(/^--([a-z]+)$/)?.[1]
    const value = rest[index + 1]
    if (!name || !allowed.has(name) || args.has(name) || !value || value.startsWith('-') || /[\s\p{Cc}]/u.test(value))
      throw new Error('invalid command or arguments')
    args.set(name, value)
  }
  return args
}

function isCommand(command: string | undefined): command is Input['command'] {
  return command !== undefined && Object.hasOwn(EFFECT_FLAGS, command)
}

function argumentsFor(argv: readonly string[]): Input {
  const [command, ...rest] = argv
  if (!isCommand(command)) throw new Error('invalid command')
  const args = readFlags(command, rest)
  const requireValue = (name: string) => {
    const value = args.get(name)
    if (value === undefined) throw new Error(`missing --${name}`)
    return value
  }
  const number = (name: string) => {
    const value = requireValue(name)
    if (!POSITIVE.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`invalid --${name}`)
    return Number(value)
  }
  const sha = (name: string) => {
    const value = requireValue(name)
    if (!SHA.test(value)) throw new Error(`--${name} must be a lowercase 40-character SHA`)
    return value
  }
  const repository = requireValue('repo')
  if (!REPOSITORY.test(repository) || repository.endsWith('/.') || repository.endsWith('/..'))
    throw new Error('invalid --repo')
  const coordinates = { repository, issue: number('issue'), mandate: requireValue('mandate') }
  if (command === 'push') {
    const pr = args.has('pr') ? number('pr') : null
    const from = args.has('from') ? sha('from') : null
    if (pr !== null && from === null) throw new Error('--pr requires --from')
    return { ...coordinates, command, tip: sha('tip'), from, pr }
  }
  if (command === 'open-pr') return { ...coordinates, command, tip: sha('tip') }
  if (command === 'land') return { ...coordinates, command, pr: number('pr'), head: sha('head') }
  return { ...coordinates, command: 'finish', pr: number('pr') }
}

export async function runFeatureCli(argv: readonly string[], runtime: Runtime) {
  if (argv.length === 1 && argv[0] === '--help') return { code: 0, text: USAGE }
  let input: Input
  try {
    input = argumentsFor(argv)
  } catch (error) {
    return { code: 2, error: `${messageOf(error)}\n${USAGE}` }
  }
  try {
    const result = await act(input, runtime)
    const failed = result.status === 'refused' || result.status === 'waiting' || result.status === 'uncertain'
    return { code: failed ? 1 : 0, text: JSON.stringify(result) }
  } catch (error) {
    const reason = refusalReason(error)
    return {
      code: 1,
      text: JSON.stringify({ status: 'refused', reason, repository: input.repository, issue: input.issue }),
    }
  }
}

if (import.meta.main) {
  const outcome = await runFeatureCli(process.argv.slice(2), { cwd: process.cwd(), gh: defaultGh(), git: defaultGit() })
  if (outcome.error !== undefined) console.error(outcome.error)
  if (outcome.text !== undefined) console.log(outcome.text)
  process.exitCode = outcome.code
}
