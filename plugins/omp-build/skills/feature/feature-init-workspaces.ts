import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isMap, type YamlMap } from './feature-init-yaml'

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
