import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  executeSimCommand,
  type SimCommandInput,
  type SimCommandResult,
} from '../skills/feature/testing/gh-simulator/sim-execution.ts'

/**
 * Pin dispatch for one `gh` call, with the caller's env and cwd. The compiled fixture and the
 * per-file server both run it. Failure-only difference: an exception escaping it (missing `PIN_*`
 * env, unreadable control file, failed git read) exits 1 in both, but the server reports it as
 * `gh simulator: <error>` instead of Bun's uncaught-exception output.
 */
export function executePinCommand(args: string[], input: SimCommandInput): SimCommandResult {
  const { cwd, readStdin } = input
  const env = input.env ?? {}
  const source = 'Roxabi/roxabi-plugins'
  const { GH_SIM_STATE, PIN_CANDIDATE, PIN_DEFAULT_HEAD, PIN_SHARED } = env
  if (!GH_SIM_STATE || !PIN_CANDIDATE || !PIN_DEFAULT_HEAD || !PIN_SHARED)
    throw new Error('isolated-pin-gh-fixture-environment-missing')
  const repo = resolve(cwd, join(GH_SIM_STATE.replace(/\/[^/]+$/, ''), 'omp-tooling.git'))
  const candidate = PIN_CANDIDATE
  const defaultHead = PIN_DEFAULT_HEAD
  const shared = PIN_SHARED
  const flag = (name: string) => args[args.indexOf(name) + 1]
  const controls = env.PIN_CONTROL_FILE
    ? (JSON.parse(readFileSync(resolve(cwd, env.PIN_CONTROL_FILE), 'utf8')) as {
        candidate?: string
        shared?: string
        target?: string
        comparison?: string
        requiredChecks?: string[]
      })
    : {}
  const git = (...argv: string[]) => execFileSync('git', argv, { cwd: repo, env, encoding: 'utf8' }).trim()
  const simulate = (stdin = readStdin) => executeSimCommand(args, { ...input, env, readStdin: stdin })
  const success = (value: unknown): SimCommandResult => ({ status: 0, stdout: `${value}\n`, stderr: '' })
  function handleFeatureGate(): void {
    if (
      env.PIN_FEATURE_GATE &&
      args[0] === 'variable' &&
      args[1] === 'get' &&
      args[2] === 'OMP_BUILD_TOOLING_SHA' &&
      flag('--repo') === source
    ) {
      writeFileSync(resolve(cwd, env.PIN_FEATURE_GATE, 'ready'), 'ready')
      readFileSync(resolve(cwd, env.PIN_FEATURE_GATE, 'release'))
    }
  }

  function handleVariable(): SimCommandResult | undefined {
    if (args[0] === 'variable' && args[1] === 'get' && args[2] === 'OMP_BUILD_TOOLING_SHA') {
      const repository = flag('--repo')
      if (repository === source || repository === 'acme/app')
        return success(repository === source ? (controls.shared ?? shared) : (controls.candidate ?? candidate))
    }
  }

  function handleSharedGraphql(): SimCommandResult | undefined {
    if (args[0] !== 'api' || args[1] !== 'graphql') return undefined
    const expression = args.find((arg) => arg.startsWith(`expression=${shared}:`))?.slice('expression='.length)
    if (!expression) return undefined
    const query = args.find((arg) => arg.startsWith('query='))
    const repository: Record<string, unknown> = {
      object: { oid: git('--no-replace-objects', 'rev-parse', expression) },
    }
    if (query?.includes('commit:object(oid:$commit)')) {
      repository.commit =
        args.includes(`commit=${shared}`) && git('--no-replace-objects', 'cat-file', '-t', shared) === 'commit'
          ? { __typename: 'Commit', oid: shared }
          : null
    }
    return success(JSON.stringify({ data: { repository } }))
  }

  function handleTargetControls(): SimCommandResult | undefined {
    if (
      args[0] === 'api' &&
      args[1] === 'repos/acme/app/branches/main/protection/required_status_checks' &&
      controls.requiredChecks
    )
      return success(JSON.stringify({ contexts: controls.requiredChecks }))
    if (args[0] === 'repo' && args[1] === 'view' && !args.includes(source) && controls.target)
      return success(JSON.stringify({ nameWithOwner: controls.target }))
  }

  function handleSync(): SimCommandResult | undefined {
    if (
      env.PIN_SYNC_DIR &&
      args[0] === 'api' &&
      args[1] === 'graphql' &&
      args.includes(`expression=${candidate}:plugins/omp-build/package.json`)
    ) {
      const countPath = resolve(cwd, env.PIN_SYNC_DIR, 'count')
      let count = 0
      try {
        count = Number(readFileSync(countPath, 'utf8'))
      } catch {}
      writeFileSync(countPath, String(++count))
      if (count === 2) {
        const response = simulate(() => '')
        if (response.status !== 0) return { status: response.status, stdout: '', stderr: response.stderr }
        writeFileSync(resolve(cwd, env.PIN_SYNC_DIR, 'ready'), 'ready')
        readFileSync(resolve(cwd, env.PIN_SYNC_DIR, 'release'))
        return { status: 0, stdout: response.stdout, stderr: '' }
      }
    }
  }

  function handleSource(): SimCommandResult | undefined {
    if (args[0] === 'api' && args[1] === `repos/${source}`)
      return success(JSON.stringify({ default_branch: 'main', full_name: source }))
    if (args[0] === 'repo' && args[1] === 'view' && args.includes(source))
      return success(
        JSON.stringify({
          nameWithOwner: source,
          defaultBranchRef: { name: 'main' },
          url: `https://github.com/${source}`,
        }),
      )
  }

  function handleSourceRefs(): SimCommandResult | undefined {
    if (args[0] === 'api' && args[1] === `repos/${source}/commits/main`)
      return success(JSON.stringify({ sha: defaultHead }))
    if (args[0] === 'api' && args[1] === `repos/${source}/git/ref/heads/main`)
      return success(JSON.stringify({ ref: 'refs/heads/main', object: { sha: defaultHead, type: 'commit' } }))
    if (args[0] === 'api' && args[1] === `repos/${source}/compare/${candidate}...${defaultHead}`)
      return success(
        JSON.stringify({
          status: controls.comparison ?? 'ahead',
          ahead_by: 1,
          behind_by: 0,
          base_commit: { sha: candidate },
          merge_base_commit: { sha: candidate },
        }),
      )
  }

  handleFeatureGate()
  return (
    handleVariable() ??
    handleSharedGraphql() ??
    handleTargetControls() ??
    handleSync() ??
    handleSource() ??
    handleSourceRefs() ??
    simulate()
  )
}
