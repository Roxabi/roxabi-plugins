import { readFileSync, realpathSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { disarmEpicControlTarget } from './epic-driver-control'
import { next } from './epic-driver-next'
import { Refused } from './epic-driver-runtime'
import { hook, markFix, report, review, stop } from './epic-driver-terminal'

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Free text — a stop detail — never travels as an argv word the caller had to
 * quote: it is read from a file, or stdin for `-`.
 */
function textFile(path: string | undefined, flag: string): string {
  if (path === undefined) return ''
  try {
    return readFileSync(path === '-' ? 0 : path, 'utf8').trim()
  } catch (error) {
    throw new Refused(`${flag} ${path}: ${error instanceof Error ? error.message : error}`)
  }
}

export async function main(argv: string[]): Promise<string> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      epic: { type: 'string' },
      repo: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      ticket: { type: 'string' },
      reason: { type: 'string', default: '' },
      'detail-file': { type: 'string' },
      'decision-record': { type: 'string', default: '' },
      range: { type: 'string', default: '' },
      outcome: { type: 'string', default: '' },
    },
  })
  const [command] = positionals
  const repo = realpathSync(values.repo ?? process.cwd())
  const epic = Number((values.epic ?? '').replace(/^#/, ''))
  if (!Number.isInteger(epic) || epic <= 0) throw new Refused('--epic <N> is required')
  const ticket = Number((values.ticket ?? '').replace(/^#/, ''))
  const detail = textFile(values['detail-file'], '--detail-file')
  switch (command) {
    case 'next':
      return JSON.stringify(await next(repo, epic, values['dry-run'] ?? false), null, 2)
    case 'stop':
      return JSON.stringify(await stop(repo, epic, ticket, values.reason, detail), null, 2)
    case 'review':
      return JSON.stringify(await review(repo, epic, values['decision-record'], values.range), null, 2)
    case 'mark-fix':
      return JSON.stringify(await markFix(repo, epic, ticket), null, 2)
    case 'control-disarm':
      return JSON.stringify(await disarmEpicControlTarget(repo, epic), null, 2)
    case 'hook': {
      const outcome = await hook(repo, epic)
      if (outcome.result === 'failed') throw new Error(`hook-failed ${JSON.stringify(outcome)}`)
      return JSON.stringify(outcome, null, 2)
    }
    case 'report': {
      const out = await report(repo, epic, values.outcome, values.reason)
      if (out.stillArmed.length) {
        console.log(out.text)
        throw new Error(`still armed: ${out.stillArmed.map((pr) => `#${pr}`).join(', ')}`)
      }
      return out.text
    }
    default:
      throw new Refused(
        `unknown subcommand ${command ?? '(none)'}: next | stop | mark-fix | review | hook | report | control-disarm`,
      )
  }
}
