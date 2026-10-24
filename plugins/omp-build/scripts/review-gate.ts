#!/usr/bin/env bun

import { admitReviewGate } from './review-gate-admission.ts'
import { output, parseArguments, trustedRoot } from './review-gate-cli.ts'

try {
  const args = parseArguments(process.argv.slice(2))
  const result = await admitReviewGate(args, await trustedRoot(args.toolingSha))
  output(result)
  if (!result.ok) process.exitCode = 1
} catch (error) {
  if (process.exitCode !== 1) {
    output({
      ok: false,
      allowed: false,
      reason: 'unreadable',
      detail: error instanceof Error ? error.message : String(error),
    })
    process.exitCode = 1
  }
}
