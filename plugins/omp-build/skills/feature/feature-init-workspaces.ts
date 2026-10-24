import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isMap, type YamlMap } from './feature-init-yaml'

const DEPENDENCY_MAPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']

function readPackage(dir: string): YamlMap | null {
  try {
    const doc: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return isMap(doc) ? doc : null
  } catch {
    return null
  }
}

/** The package names a package.json declares in its dependency maps. Scripts are not dependencies. */
function dependencyNames(pkg: YamlMap | null): string[] {
  if (!pkg) return []
  return DEPENDENCY_MAPS.flatMap((key) => {
    const deps = pkg[key]
    return isMap(deps) ? Object.keys(deps) : []
  })
}

/** One `workspaces` glob as an anchored regex over `/`-joined relative paths. */
function workspaceGlob(glob: string): RegExp {
  const parts = glob.replace(/^\.\//, '').replace(/\/+$/, '').split('/')
  let source = ''
  parts.forEach((part, index) => {
    const last = index === parts.length - 1
    if (part === '**') source += last ? '(?:[^/]+(?:/[^/]+){0,2})?' : '(?:[^/]+/){0,3}'
    else source += part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + (last ? '' : '/')
  })
  return new RegExp(`^${source}$`)
}

type WorkspacePatterns = { include: RegExp[]; exclude: RegExp[] }

function workspacePatterns(pkg: YamlMap | null): WorkspacePatterns {
  const field = pkg?.workspaces
  const globs = Array.isArray(field) ? field : isMap(field) && Array.isArray(field.packages) ? field.packages : []
  const patterns = globs.filter((glob): glob is string => typeof glob === 'string')
  return {
    include: patterns.filter((glob) => !glob.startsWith('!')).map(workspaceGlob),
    exclude: patterns.filter((glob) => glob.startsWith('!')).map((glob) => workspaceGlob(glob.slice(1))),
  }
}

function workspaceChildren(dir: string, rel: string): string[] {
  try {
    return readdirSync(join(dir, rel), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function selectedWorkspace(rel: string, patterns: WorkspacePatterns): boolean {
  return patterns.include.some((re) => re.test(rel)) && !patterns.exclude.some((re) => re.test(rel))
}

function collectWorkspaceDirs(
  dir: string,
  patterns: WorkspacePatterns,
  rel = '',
  depth = 0,
  out: string[] = [],
): string[] {
  if (out.length >= 500 || depth > 4) return out
  for (const name of workspaceChildren(dir, rel)) {
    const child = rel ? `${rel}/${name}` : name
    if (selectedWorkspace(child, patterns) && existsSync(join(dir, child, 'package.json'))) out.push(join(dir, child))
    collectWorkspaceDirs(dir, patterns, child, depth + 1, out)
  }
  return out
}

/** Bounded expansion of npm/bun `workspaces` globs: `*` is one level, `**` up to three, `!` excludes. */
export function workspaceDirs(dir: string, pkg: YamlMap | null): string[] {
  const patterns = workspacePatterns(pkg)
  return patterns.include.length ? collectWorkspaceDirs(dir, patterns) : []
}

const VITEST_CONFIG = /^vitest\.(?:config|workspace)\.[a-z]+$/

/**
 * True when the repository uses vitest: a `vitest` or `@vitest/*` dependency,
 * or a `vitest.config.*` / `vitest.workspace.*` file, at the root or in a
 * `workspaces` package. A script that merely mentions vitest does not count.
 */
export function detectsVitest(dir: string): boolean {
  const root = readPackage(dir)
  for (const pkgDir of [dir, ...workspaceDirs(dir, root)]) {
    const pkg = pkgDir === dir ? root : readPackage(pkgDir)
    if (dependencyNames(pkg).some((name) => name === 'vitest' || name.startsWith('@vitest/'))) return true
    try {
      if (readdirSync(pkgDir).some((name) => VITEST_CONFIG.test(name))) return true
    } catch {}
  }
  return false
}
