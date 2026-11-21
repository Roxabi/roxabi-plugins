#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { executePinCommand } from './isolated-pin-gh-core.ts'

const result = executePinCommand(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  readStdin: () => readFileSync(0, 'utf8'),
})
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
if (result.status !== 0) process.exit(result.status)
