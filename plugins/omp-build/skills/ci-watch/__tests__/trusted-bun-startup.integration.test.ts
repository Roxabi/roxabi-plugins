import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

it.each(['tsconfig.json', 'jsconfig.json'])(
  'isolates manual inspection and watcher startup from candidate %s',
  (configName) => {
    const root = mkdtempSync(path.join(tmpdir(), 'trusted startup '))
    try {
      const candidate = path.join(root, 'candidate repository')
      const installed = path.join(root, 'installed plugin')
      const bin = path.join(root, 'local bin')
      const home = path.join(root, 'isolated home')
      mkdirSync(candidate)
      mkdirSync(bin)
      mkdirSync(home)
      cpSync(path.resolve(import.meta.dirname, '../../..'), installed, { recursive: true })
      const feature = path.join(installed, 'skills/feature')
      const marker = path.join(root, 'candidate preload executed')
      const log = path.join(root, 'api calls')
      writeFileSync(
        path.join(candidate, 'bunfig.toml'),
        `preload = ["./candidate-preload.ts"]\n[define]\n"process.env.OMP_STARTUP_SENTINEL" = "'candidate-defined'"\n`,
      )
      writeFileSync(
        path.join(candidate, 'candidate-preload.ts'),
        `await Bun.write(${JSON.stringify(marker)}, 'executed')\n`,
      )
      writeFileSync(
        path.join(candidate, configName),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              'node:child_process': ['./candidate-preload.ts'],
              'node:fs': ['./candidate-preload.ts'],
              '*': ['./candidate-preload.ts'],
            },
          },
        }),
      )
      writeFileSync(path.join(candidate, '.env'), 'OMP_STARTUP_SENTINEL=candidate\n')
      mkdirSync(path.join(candidate, '.dev'))
      writeFileSync(
        path.join(candidate, '.dev/stack.yml'),
        'landing:\n  mode: merge-on-green\n  required_checks:\n    - candidate-required\n',
      )

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        STARTUP_GH_LOG: log,
        GH_TOKEN: '',
        GITHUB_TOKEN: '',
      }
      delete env.OMP_STARTUP_SENTINEL
      const run = (command: string, args: string[]) =>
        spawnSync(command, args, { cwd: candidate, env, encoding: 'utf8', timeout: 20_000 })
      const git = (...args: string[]) => {
        const result = run('git', args)
        expect(result.status, result.stderr).toBe(0)
      }
      git('init', '-q')
      git('add', '.dev/stack.yml')
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'candidate base')
      git('update-ref', 'refs/remotes/origin/main', 'HEAD')

      const gh = path.join(bin, 'gh')
      writeFileSync(
        gh,
        `#!/bin/bash
printf '%s|%s|%s|%s\\n' "$PWD" "\${OMP_STARTUP_SENTINEL-unset}" "$(pwd -P)" "$*" >> "$STARTUP_GH_LOG"
if [[ "$*" == 'repo view --json nameWithOwner --jq .nameWithOwner' ]]; then printf 'acme/app\\n'; exit 0; fi
if [[ "$*" == 'repo view --json nameWithOwner' ]]; then printf '{"nameWithOwner":"acme/app"}\\n'; exit 0; fi
if [[ "$1" == api && "$2" == --include && "$3" == 'repos/acme/app/actions/variables?per_page=100&page=1' ]]; then printf 'HTTP/2 200\\r\\nContent-Type: application/json\\r\\n\\r\\n{"total_count":0,"variables":[]}\\n'; exit 0; fi
if [[ "$1 $2" == 'pr view' && "$3" == 7 && "$4" == --repo && "$5" == acme/app ]]; then printf '%s\\n' '{"state":"OPEN","mergeStateStatus":"CLEAN","headRefOid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","statusCheckRollup":[{"name":"candidate-required","status":"COMPLETED","conclusion":"SUCCESS"},{"name":"unrelated","status":"COMPLETED","conclusion":"FAILURE"}]}'; exit 0; fi
exit 91
`,
      )
      chmodSync(gh, 0o755)

      const launcher = path.join(feature, 'trusted-bun.sh')
      const probe = run('bash', [
        launcher,
        '-e',
        'console.log(JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(1),sentinel:process.env.OMP_STARTUP_SENTINEL ?? null}))',
        'argument with spaces',
      ])
      expect(probe.status, probe.stderr).toBe(0)
      expect(JSON.parse(probe.stdout)).toEqual({
        cwd: candidate,
        argv: ['argument with spaces'],
        sentinel: null,
      })

      const inspect = run('bash', [launcher, path.join(feature, 'head-authorization-cli.js'), 'inspect', '--pr', '7'])
      expect(inspect.status).toBe(1)
      expect(inspect.stdout.trim()).toBe('')
      let calls = readFileSync(log, 'utf8').trim().split('\n')
      expect(calls.some((call) => call.endsWith('repo view --json nameWithOwner'))).toBe(true)
      expect(
        calls.some((call) => call.endsWith('api --include repos/acme/app/actions/variables?per_page=100&page=1')),
      ).toBe(true)

      const watcher = run('bash', [
        path.join(installed, 'skills/ci-watch/ci-watch.sh'),
        '7',
        '--base',
        'main',
        '--interval',
        '0',
        '--timeout',
        '30s',
      ])
      calls = readFileSync(log, 'utf8').trim().split('\n')
      const safeWords = [
        'repo',
        'view',
        '--json',
        'nameWithOwner',
        '--jq',
        '.nameWithOwner',
        'pr',
        '7',
        '--repo',
        'acme/app',
        'state,mergeStateStatus,autoMergeRequest,headRefOid,statusCheckRollup',
        'api',
        '--include',
        'repos/acme/app/actions/variables?per_page=100&page=1',
      ]
      const safeCalls = calls.map((call) =>
        (call.split('|')[3] ?? '')
          .split(' ')
          .map((word) => (safeWords.includes(word) ? word : '<redacted>'))
          .join(' '),
      )
      expect(watcher.status, `watcher stderr: ${watcher.stderr}\ngh calls: ${safeCalls.join('\n')}`).toBe(4)
      expect(
        calls.filter((call) => call.endsWith('api --include repos/acme/app/actions/variables?per_page=100&page=1'))
          .length,
      ).toBeGreaterThanOrEqual(2)
      expect(calls.some((call) => call.includes('pr view 7 --repo acme/app'))).toBe(true)
      const safety = calls.map((call) => {
        const [logicalCwd, sentinel, physicalCwd, command = ''] = call.split('|')
        const commandKind = command.startsWith('repo view ')
          ? 'repo view'
          : command.startsWith('pr view ')
            ? 'pr view'
            : command.startsWith('api ')
              ? 'api'
              : 'other'
        return {
          logicalCandidateCwd: logicalCwd === candidate,
          physicalCandidateCwd: physicalCwd === candidate,
          sentinelAbsent: sentinel === 'unset',
          commandKind,
        }
      })
      expect(
        safety.every(
          ({ logicalCandidateCwd, physicalCandidateCwd, sentinelAbsent }) =>
            logicalCandidateCwd && physicalCandidateCwd && sentinelAbsent,
        ),
        JSON.stringify(safety),
      ).toBe(true)
      expect(calls.every((call) => !/\b(POST|PATCH|PUT|DELETE|merge)\b/i.test(call))).toBe(true)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  60_000,
)
