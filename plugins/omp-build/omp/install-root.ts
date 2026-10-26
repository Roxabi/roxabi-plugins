import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const INSTALL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

type InstallRootStatus = { present: true } | { present: false; root: string; version: string }

export function installRootStatus(
  root = INSTALL_ROOT,
  exists: (path: string) => boolean = existsSync,
): InstallRootStatus {
  if (exists(root)) return { present: true }
  return { present: false, root, version: basename(root).split('___').at(-1) ?? 'unknown' }
}

export function replacedInstallRootMessage(root: string, version: string): string {
  return `omp-build ${version} is running from a replaced installation root at ${root}. Restart this session.`
}
