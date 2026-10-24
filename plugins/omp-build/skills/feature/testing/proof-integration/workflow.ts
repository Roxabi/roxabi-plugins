import { spawnSync } from 'node:child_process'
import { WORKFLOW } from '../../__fixtures__/proof/sandbox-repository'
import type { Box } from '../../__fixtures__/proof/sandbox-types'
import { REAL_BUN } from './environment'

/** Fork the real read/validation owners, not a copied digest or producer result. */
export function workflowRead(
  box: Box,
  cwd: string,
  pr: number,
  head: string,
  fn: 'captureReviewInput' | 'validateReviewInput',
  input?: string | null,
): {
  ok: boolean
  input?: string | null
  body?: { body: string; lastEditedAt: string | null } | null
  semctx?: unknown | null
  assertledger?: unknown | null
  reason?: string
  error?: string
} {
  const out = spawnSync(REAL_BUN, [WORKFLOW, fn, cwd, JSON.stringify({ pr, head, input })], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (out.status !== 0) throw new Error(`${fn} failed: ${out.stderr}`)
  return JSON.parse(out.stdout)
}
