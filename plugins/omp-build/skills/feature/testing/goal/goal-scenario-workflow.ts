/**
 * Forked so the direct workflow leaves `Bun.spawn` under real bun. The
 * Vitest worker's `Bun.spawn` exits 1 with an empty payload even for `/bin/echo`.
 */

import { landPr } from '../../workflow-landing.js'
import { openPr } from '../../workflow-pr.js'
import type { LandingConfig } from '../../workflow-readiness.d.ts'
import { captureReviewInput, validateReviewInput } from '../../workflow-review-input.js'
import { applyCiWatchExit } from '../../workflow-watch.js'

const [, , fn, cwd, payloadText] = process.argv
const payload: {
  issue?: number
  branch?: string
  base?: string
  title?: string
  pr?: number
  code?: number
  mode?: string
  landing?: LandingConfig
  head?: string
  input?: string | null
} = JSON.parse(payloadText ?? '{}')

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
