import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PRODUCT = 'Acme/product'
export const PARENT = 'Kit/parent'
export const CREDENTIAL = 'fixture-only-credential'
export const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

export const supportedOrigins = [
  ['literal GitHub HTTPS', 'https://GITHUB.COM/Acme/product.git/'],
  ['credentialed GitHub HTTPS', `https://user:${CREDENTIAL}@github.com/Acme/product.git`],
  ['literal GitHub SCP', 'git@github.com:Acme/product.git'],
  ['literal GitHub SSH on port 443', 'ssh://git@ssh.github.com:443/Acme/product.git'],
  ['GitHub SCP alias', 'git@github-work:Acme/product.git'],
  ['GitHub SSH alias', 'ssh://git@github-work:22/Acme/product.git'],
] as const

export const refusedOrigins = [
  ['GitLab SCP', 'git@gitlab.com:acme/product.git'],
  ['local checkout path', '/srv/git/product.git'],
  ['nested GitLab HTTPS', 'https://gitlab.com/group/sub/product.git'],
  ['credentialed foreign HTTPS', `https://user:${CREDENTIAL}@gitlab.com/group/sub/product.git`],
  ['foreign SCP alias', 'git@gitlab-work:Acme/product.git'],
  ['foreign SSH alias', 'ssh://git@gitlab-work/Acme/product.git'],
  ['GitHub lookalike HTTPS', 'https://github.com.example.net/Acme/product.git'],
  ['GitHub name in a foreign HTTPS path', 'https://gitlab.com/x@github.com/Acme/product.git'],
  ['GitHub name in a foreign SCP path', 'git@gitlab.com:x@github.com:Acme/product.git'],
  ['GitHub HTTPS with extra path segments', 'https://github.com/group/Acme/product.git'],
] as const

export type RepoFixtureOptions = { origin?: string | null; single?: boolean; yamlPin?: string }

export function repoFixture({ origin, single, yamlPin }: RepoFixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'triage-origin-'))
  const cwd = join(root, 'checkout')
  const bin = join(root, 'bin')
  mkdirSync(cwd)
  mkdirSync(bin)
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, env: { ...GIT_ENV, PATH: '/usr/bin:/bin' }, stdio: 'pipe' })
  git('init', '-q')
  if (origin !== null) git('remote', 'add', 'origin', origin ?? `https://github.com/${PRODUCT}.git`)
  if (!single) git('remote', 'add', 'upstream', `https://github.com/${PARENT}.git`)
  if (yamlPin !== undefined) {
    mkdirSync(join(cwd, '.dev'))
    writeFileSync(join(cwd, '.dev', 'dev-core.yml'), `github_repo: '${yamlPin}'\n`)
  }
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/sh
[ "$1" = -G ] || exit 91
for host; do :; done
case "$host" in
  github-work) host=github.com ;;
  gitlab-work) host=gitlab.com ;;
esac
printf 'hostname %s\n' "$host"
`,
    { mode: 0o755 },
  )
  return { root, cwd, bin }
}
