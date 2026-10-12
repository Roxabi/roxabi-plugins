/**
 * Forked so `workflow.js` calls `Bun.spawn` under real bun. The vitest worker's
 * `Bun.spawn` exits 1 with an empty payload even for `/bin/echo`.
 */
import { applyCiWatchExit, captureReviewInput, landPr, openPr, validateReviewInput } from './workflow.js'

const [fn, cwd, payloadText] = process.argv.slice(2)
const payload = JSON.parse(payloadText ?? '{}') as {
  issue?: number
  branch?: string
  base?: string
  title?: string
  pr?: number
  code?: number
  mode?: string
  landing?: { mode: string; required_checks: string[] }
  head?: string
  input?: string | null
}

const result =
  fn === 'openPr'
    ? await openPr(cwd ?? '', {
        issue: payload.issue ?? 0,
        branch: payload.branch ?? '',
        base: payload.base ?? '',
        title: payload.title ?? '',
      })
    : fn === 'landPr'
      ? await landPr(cwd ?? '', payload.pr ?? 0, { landing: payload.landing })
      : fn === 'captureReviewInput'
        ? await captureReviewInput(cwd ?? '', payload.pr ?? 0, payload.head ?? '')
        : fn === 'validateReviewInput'
          ? await validateReviewInput(cwd ?? '', payload.pr ?? 0, payload.head ?? '', payload.input ?? null)
          : fn === 'applyCiWatchExit'
            ? await applyCiWatchExit(cwd ?? '', payload.pr ?? 0, payload.code ?? 1, { mode: payload.mode })
            : null

if (result === null) {
  process.stderr.write(`unknown workflow call ${fn ?? ''}\n`)
  process.exit(1)
}
process.stdout.write(`${JSON.stringify(result)}\n`)
