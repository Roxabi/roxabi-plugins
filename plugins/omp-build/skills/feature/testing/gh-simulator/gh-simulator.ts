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
import { readFileSync } from 'node:fs'
import { executeSimCommand } from './sim-execution.ts'

const argv = process.argv.slice(2)
const result = executeSimCommand(argv, {
  cwd: process.cwd(),
  readStdin: () => readFileSync(0, 'utf8'),
})
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
if (result.status !== 0) process.exit(result.status)
