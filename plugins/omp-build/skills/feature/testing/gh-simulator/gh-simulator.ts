#!/usr/bin/env bun
/**
 * Stateful fake `gh` for the omp-build goal path (#654).
 *
 * Backed by `GH_SIM_STATE` (JSON). The command surface covers the calls made
 * by epic-driver, workflow, and ci-watch. Unknown commands and queries exit
 * non-zero with their argv. State hydration, locking, persistence, real Git
 * merge/worktree cleanup, GraphQL, REST/form parsing, JQ, and the command
 * transaction order are implemented in the cohesive sibling modules.
 */
import { handle } from './sim-command.ts'
import { withState } from './sim-state.ts'

const argv = process.argv.slice(2)
try {
  withState((state) => handle(state, argv))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const text =
    message.startsWith('match-head-commit') || message.startsWith('auto-merge') || message.startsWith('gh:')
      ? message
      : `gh: ${message}\n${argv.join(' ')}`
  process.stderr.write(`${text}\n`)
  process.exit(1)
}
