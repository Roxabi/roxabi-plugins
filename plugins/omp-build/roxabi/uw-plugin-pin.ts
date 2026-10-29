import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Gh } from '../adapters/github/types.ts'
import type { Result } from '../engine/result.ts'
import { INSTALL_ROOT } from '../omp/install-root.ts'
import type { InstalledPluginPin, PluginPinPort, TrustedHostPluginPin } from './uw-action-contract.ts'
import { actionFailure, isGitSha } from './uw-action-result.ts'
import { readGitFileBytes } from './uw-git-bytes.ts'

const execFileAsync = promisify(execFile)
const VARIABLE = 'OMP_BUILD_TOOLING_SHA'
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export type PluginPinSource = {
  cwd: string
  gh: Gh
  trusted?: TrustedHostPluginPin
}

/** Same filesystem root `pluginPinPort` byte-compares. Trusted host root wins; otherwise the running install. */
export function pinnedInstalledRoot(pluginPin?: TrustedHostPluginPin, installedRoot = INSTALL_ROOT): string {
  return pluginPin?.installedRoot ?? installedRoot
}

type PackageIdentity = { version: string; repository: string; root: string; bytes: Uint8Array }

function packageIdentity(installedRoot: string): Result<PackageIdentity> {
  let bytes: Uint8Array
  let parsed: unknown
  try {
    bytes = readFileSync(join(installedRoot, 'package.json'))
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch (error) {
    return actionFailure(
      'plugin-pin-unavailable',
      `Installed plugin package cannot be read: ${error instanceof Error ? error.message : 'unreadable'}`,
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return actionFailure('plugin-pin-unavailable', 'Installed plugin package.json is not an object')
  }
  const body = parsed as { name?: unknown; version?: unknown; repository?: unknown }
  if (body.name !== 'omp-build' || typeof body.version !== 'string' || body.version.length === 0) {
    return actionFailure('plugin-pin-unavailable', 'Installed package is not omp-build with a version')
  }
  const repository = body.repository
  if (repository === null || typeof repository !== 'object' || Array.isArray(repository)) {
    return actionFailure('plugin-pin-unavailable', 'omp-build package.json has no repository identity')
  }
  const source = repository as { type?: unknown; url?: unknown; directory?: unknown }
  const match =
    typeof source.url === 'string'
      ? source.url.match(/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/)
      : null
  if (
    source.type !== 'git' ||
    match === null ||
    typeof source.directory !== 'string' ||
    source.directory.length === 0
  ) {
    return actionFailure('plugin-pin-unavailable', 'Plugin repository metadata does not name a GitHub directory')
  }
  return { ok: true, value: { version: body.version, repository: match[1], root: source.directory, bytes } }
}

async function approvedVariable(source: PluginPinSource, repository: string): Promise<Result<string>> {
  let raw: string
  try {
    raw = await source.gh(source.cwd, ['variable', 'get', VARIABLE, '--repo', repository])
  } catch (error) {
    return actionFailure(
      'plugin-pin-unavailable',
      `Approved tooling variable ${VARIABLE} is unreadable in ${repository}: ${error instanceof Error ? error.message : 'GitHub CLI failed'}`,
    )
  }
  const commit = raw.trim()
  if (!isGitSha(commit)) return actionFailure('plugin-pin-unavailable', `${VARIABLE} is not a 40-character commit`)
  return { ok: true, value: commit }
}

async function pinFrom(
  identity: PackageIdentity,
  repository: string,
  commit: string,
  cwd: string,
  gh: Gh,
): Promise<Result<InstalledPluginPin>> {
  if (!REPOSITORY.test(repository) || repository !== identity.repository) {
    return actionFailure(
      'plugin-pin-mismatch',
      `Plugin pin repository ${repository} is not the installed package identity ${identity.repository}`,
    )
  }
  const pinned = await readGitFileBytes({
    repository,
    commit,
    path: `${identity.root}/package.json`,
    cwd,
    gh,
  })
  if (!pinned.ok) return pinned
  if (Buffer.compare(Buffer.from(pinned.value), Buffer.from(identity.bytes)) !== 0) {
    return actionFailure(
      'plugin-pin-mismatch',
      `Installed omp-build ${identity.version} bytes do not match ${repository}@${commit}:${identity.root}/package.json`,
    )
  }
  return {
    ok: true,
    value: { name: 'omp-build', version: identity.version, repository, commit, root: identity.root },
  }
}

export async function resolvePluginPin(
  source: PluginPinSource,
  installedRoot = INSTALL_ROOT,
): Promise<Result<InstalledPluginPin>> {
  const identity = packageIdentity(source.trusted?.installedRoot ?? installedRoot)
  if (!identity.ok) return identity
  if (source.trusted !== undefined)
    return pinFrom(identity.value, source.trusted.repository, source.trusted.commit, source.cwd, source.gh)
  const variable = await approvedVariable(source, identity.value.repository)
  if (!variable.ok) return variable
  return pinFrom(identity.value, identity.value.repository, variable.value, source.cwd, source.gh)
}

export function pluginPinPort(source: PluginPinSource, installedRoot = INSTALL_ROOT): PluginPinPort {
  const root = pinnedInstalledRoot(source.trusted, installedRoot)
  return {
    resolveInstalledPluginPin: () => resolvePluginPin(source, root),
    readInstalledFile: async (path) => {
      if (path.length === 0 || path.startsWith('/') || path.split('/').includes('..')) {
        return actionFailure('plugin-pin-mismatch', 'Installed plugin path is not repository-relative')
      }
      try {
        return { ok: true, value: readFileSync(join(root, path)) }
      } catch (error) {
        return actionFailure(
          'plugin-pin-mismatch',
          `Installed plugin file is unreadable: ${path}: ${error instanceof Error ? error.message : 'missing'}`,
        )
      }
    },
  }
}

export function installedPluginRoot(): string {
  return fileURLToPath(new URL('.', import.meta.url))
}

export async function variableLooksLikeCommit(cwd: string, repository: string): Promise<boolean> {
  try {
    const raw = await execFileAsync('gh', ['variable', 'get', VARIABLE, '--repo', repository], {
      cwd,
      encoding: 'utf8',
    })
    return isGitSha(raw.stdout.trim())
  } catch {
    return false
  }
}
