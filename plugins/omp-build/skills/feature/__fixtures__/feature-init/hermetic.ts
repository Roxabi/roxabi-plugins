import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type HermeticGh = {
  /** Child env: stub `gh` first on PATH, empty GH_CONFIG_DIR, no GH_* / GITHUB_TOKEN / GIT_*. */
  env: NodeJS.ProcessEnv
  /** Every argv the stub received, in call order. */
  calls: () => string[][]
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * A `gh` that can only answer `answer.argv` exactly, with `answer.body`. Any
 * other call exits 1. Every call is logged, so a test can assert what was asked
 * and prove the host gh was never the one answering.
 */
export function hermeticGh(root: string, answer?: { argv: string[]; body: string }): HermeticGh {
  const bin = path.join(root, 'gh-stub', 'bin')
  const config = path.join(root, 'gh-stub', 'config')
  const log = path.join(root, 'gh-stub', 'calls.log')
  mkdirSync(bin, { recursive: true })
  mkdirSync(config, { recursive: true })
  const expected = answer ? answer.argv.map(quote).join(' ') : ''
  const body = answer ? answer.body.replace(/'/g, `'\\''`) : ''
  writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env bash
for arg in "$@"; do printf '%s\\n' "$arg" >> ${quote(log)}; done
printf '%s\\n' '<end>' >> ${quote(log)}
${
  answer
    ? `expected=(${expected})
[ "$#" -eq "\${#expected[@]}" ] || exit 1
i=0
for arg in "$@"; do [ "$arg" = "\${expected[$i]}" ] || exit 1; i=$((i + 1)); done
printf '%s' '${body}'
exit 0`
    : 'exit 1'
}
`,
  )
  chmodSync(path.join(bin, 'gh'), 0o755)
  const inherited = Object.entries(process.env).filter(
    ([key]) => !key.startsWith('GIT_') && !key.startsWith('GH_') && key !== 'GITHUB_TOKEN',
  )
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(inherited),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
    GH_CONFIG_DIR: config,
    GH_PROMPT_DISABLED: '1',
    PATH: `${bin}:${process.env.PATH ?? ''}`,
  }
  const calls = () => {
    if (!existsSync(log)) return []
    const out: string[][] = []
    let current: string[] = []
    for (const line of readFileSync(log, 'utf8').split('\n').slice(0, -1)) {
      if (line === '<end>') {
        out.push(current)
        current = []
      } else current.push(line)
    }
    return out
  }
  return { env, calls }
}
