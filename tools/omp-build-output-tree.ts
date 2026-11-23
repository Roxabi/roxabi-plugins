import { lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

// An empty relative path represents the root itself, not a descendant.
function isDescendant(root: string, path: string): boolean {
  const name = relative(root, path)
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name)
}

function physicalDestination(path: string): string {
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) return realpathSync(path)
  return join(physicalDestination(dirname(path)), relative(dirname(path), path))
}

export function createFreshOutputRoot(path: string, protectedRoots: readonly string[]): string {
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined)
    throw new Error(`temporary output root already exists: ${path}`)
  const destination = join(physicalDestination(dirname(path)), relative(dirname(path), path))
  for (const root of protectedRoots) {
    const physicalRoot = lstatSync(root, { throwIfNoEntry: false }) === undefined ? root : realpathSync(root)
    if (isDescendant(root, path) || destination === physicalRoot || isDescendant(physicalRoot, destination)) {
      throw new Error(`temporary output root overlaps protected paths: ${path} -> ${destination}`)
    }
  }
  mkdirSync(dirname(destination), { recursive: true })
  // Do not reuse a destination that appeared after the absence check.
  mkdirSync(destination)
  return destination
}

function requireDirectory(path: string, create: boolean): void {
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (entry === undefined && create) mkdirSync(path)
  else if (!entry?.isDirectory()) throw new Error(`omp-build expected a physical output directory: ${path}`)
}

export type RemoveOutput = (path: string, directory: boolean) => void

function removeOutput(path: string, directory: boolean): void {
  if (directory) rmdirSync(path)
  else unlinkSync(path)
}

function pruneOperation<T>(operation: string, path: string, run: () => T): T {
  try {
    return run()
  } catch (cause) {
    throw new Error(`omp-build prune ${operation} failed: ${path}`, { cause })
  }
}

export function outputTree(root: string) {
  const roots = [join(root, 'agents'), join(root, 'dist')]
  function checkRoots(create: boolean): void {
    requireDirectory(root, false)
    if (realpathSync(root) !== root) throw new Error(`omp-build output destination has a linked parent: ${root}`)
    for (const path of roots) requireDirectory(path, create)
  }
  checkRoots(true)

  return {
    checkWrite(path: string): void {
      const managed = roots.find((directory) => isDescendant(directory, path))
      if (managed === undefined) throw new Error(`omp-build output escapes managed directories: ${path}`)
      requireDirectory(managed, false)
      let parent = managed
      for (const name of relative(managed, dirname(path)).split(sep).filter(Boolean)) {
        parent = join(parent, name)
        requireDirectory(parent, true)
      }
      const entry = lstatSync(path, { throwIfNoEntry: false })
      if (entry !== undefined && (!entry.isFile() || entry.nlink > 1))
        throw new Error(`omp-build expected an ordinary unshared output file: ${path}`)
    },
    prune(written: ReadonlySet<string>, remove: RemoveOutput = removeOutput): void {
      function removeEntry(path: string, directory: boolean): void {
        pruneOperation(directory ? 'rmdir' : 'unlink', path, () => remove(path, directory))
      }
      function visit(path: string): boolean {
        const names = pruneOperation('readdir', path, () => readdirSync(path)).sort()
        let empty = true
        for (const name of names) {
          const child = join(path, name)
          if (written.has(relative(root, child).split(sep).join('/'))) {
            empty = false
            continue
          }
          const directory = pruneOperation('lstat', child, () => lstatSync(child)).isDirectory()
          if (!directory || visit(child)) removeEntry(child, directory)
          else empty = false
        }
        return empty
      }
      checkRoots(false)
      for (const path of roots) visit(path)
    },
  }
}
