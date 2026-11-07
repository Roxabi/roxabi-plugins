import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { BRANCH } from '../testing/feature-recovery-fixture.ts'
import { git, readSim } from '../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../testing/sandbox/sandbox-types.ts'

const RUNNER = path.resolve(import.meta.dirname, '../testing/feature-recovery-runner.ts')
const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()

export function invoke<T>(box: Box, cwd: string, home: string, operation: string, payload: object): T {
  mkdirSync(home, { recursive: true })
  const run = spawnSync(BUN, [RUNNER, operation, cwd, JSON.stringify(payload)], {
    cwd,
    env: { ...box.env, HOME: home },
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`${operation} failed: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as T
}

export function effectCalls(box: Box, start: number): string[][] {
  return readSim(box)
    .calls.slice(start)
    .filter((args) => {
      const joined = args.join(' ')
      const method = args.indexOf('--method')
      return (
        (method !== -1 && args[method + 1]?.toUpperCase() !== 'GET') ||
        /\b(comment|edit|merge)\b/.test(joined) ||
        (args[0] === 'workflow' && args[1] === 'run')
      )
    })
}

export function coldCheckout(box: Box, name: string, branch = BRANCH): string {
  const principal = path.join(box.root, `${name}-principal`)
  const checkout = path.join(box.root, `${name}-checkout`)
  git(box, box.root, ['clone', '-q', box.origin, principal])
  git(box, principal, ['remote', 'set-url', 'origin', 'https://github.com/acme/app.git'])
  git(box, principal, ['config', `url.${box.origin}.insteadOf`, 'https://github.com/acme/app.git'])
  git(box, principal, ['worktree', 'add', '-q', '-b', branch, checkout, `origin/${branch}`])
  return checkout
}
