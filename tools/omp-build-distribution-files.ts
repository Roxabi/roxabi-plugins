import { execFileSync } from 'node:child_process'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Snapshot = Map<string, Buffer>

const managedDirectories = ['agents', 'dist'] as const

export function gitBytes(root: string, args: string[]): Buffer {
  try {
    return execFileSync('git', args, { cwd: root })
  } catch (error) {
    const result = error as { stderr?: Buffer; status?: number }
    throw new Error(
      `git ${args.join(' ')} failed (${result.status ?? 'unknown'}): ${result.stderr?.toString().trim() ?? ''}`,
    )
  }
}

function walk(root: string, prefix = ''): Snapshot {
  const files: Snapshot = new Map()
  const visit = (directory: string, name: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name)
      const current = name === '' ? entry.name : `${name}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error(`generated output contains a symlink: ${current}`)
      if (entry.isDirectory()) visit(absolute, current)
      else if (entry.isFile()) files.set(current, readFileSync(absolute))
      else throw new Error(`generated output contains a non-file: ${current}`)
    }
  }
  visit(root, prefix)
  return files
}

export function snapshot(root: string): Snapshot {
  const output: Snapshot = new Map()
  for (const directory of managedDirectories) {
    const path = join(root, directory)
    const entry = lstatSync(path)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${directory} must be a physical directory`)
    for (const [name, bytes] of walk(path, directory)) output.set(name, bytes)
  }
  return output
}

export function compare(label: string, expected: Snapshot, actual: Snapshot): void {
  const missing = [...expected.keys()].filter((path) => !actual.has(path))
  const extra = [...actual.keys()].filter((path) => !expected.has(path))
  const changed = [...expected.keys()].filter((path) => {
    const value = actual.get(path)
    return value !== undefined && !value.equals(expected.get(path) as Buffer)
  })
  if (missing.length + extra.length + changed.length > 0)
    throw new Error(
      `${label}: missing=[${missing.join(', ')}] extra=[${extra.join(', ')}] changed=[${changed.join(', ')}]`,
    )
}

export function headOutputs(root: string): Snapshot {
  const result: Snapshot = new Map()
  const listing = gitBytes(root, [
    'ls-tree',
    '-r',
    '-z',
    'HEAD',
    '--',
    'plugins/omp-build/agents',
    'plugins/omp-build/dist',
  ]).toString()
  for (const entry of listing.split('\0').filter(Boolean)) {
    const path = entry.slice(entry.indexOf('\t') + 1)
    result.set(path.slice('plugins/omp-build/'.length), gitBytes(root, ['show', `HEAD:${path}`]))
  }
  return result
}
