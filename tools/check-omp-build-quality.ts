#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { closeSync, type Dirent, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { isScenario } from './omp-build-quality-scenarios.ts'

type Classification = 'source' | 'scenario'
type Candidate = { path: string; classification: Classification; lines: number }
type Options = { root: string; withBiome: boolean }

type PluginVisitor = (directory: string, name: string) => void
type DirectoryVisitor = (directory: string) => void

const sourceLimit = 300
const scenarioLimit = 600
const codeExtensions: Record<string, true> = {
  '.ts': true,
  '.tsx': true,
  '.mts': true,
  '.cts': true,
  '.js': true,
  '.jsx': true,
  '.mjs': true,
  '.cjs': true,
  '.py': true,
  '.sh': true,
  '.bash': true,
}

const biomeExtensions: Record<string, true> = {
  '.ts': true,
  '.tsx': true,
  '.mts': true,
  '.cts': true,
  '.js': true,
  '.jsx': true,
  '.mjs': true,
  '.cjs': true,
}

const authoredConfigurationPaths: Record<string, true> = {
  'package.json': true,
  '.omp-plugin/plugin.json': true,
  'skills/dev-review/review-classes.yml': true,
}

function usage(): never {
  throw new Error('usage: bun tools/check-omp-build-quality.ts [--root <repository-root>] [--with-biome]')
}

function optionsFromArgs(args: string[]): Options {
  const defaultRoot = resolve(import.meta.dirname, '..')
  if (args.length === 0) return { root: defaultRoot, withBiome: false }
  if (args.length === 1 && args[0] === '--with-biome') return { root: defaultRoot, withBiome: true }
  if (args.length === 2 && args[0] === '--root') return { root: resolve(args[1]), withBiome: false }
  if (args.length === 3 && args.includes('--with-biome')) {
    const root = args.indexOf('--root')
    if (root !== -1 && root < 2 && args[root + 1] !== '--with-biome')
      return { root: resolve(args[root + 1]), withBiome: true }
  }
  return usage()
}

function requireDirectory(path: string, label: string): void {
  if (!existsSync(path) || !lstatSync(path).isDirectory())
    throw new Error(`expected ${label} directory is missing: ${path}`)
}

function isCode(path: string): boolean {
  if (extname(path) in codeExtensions) return true
  const descriptor = openSync(path, 'r')
  const header = Buffer.alloc(128)
  try {
    return /^#!.*\b(?:bash|sh|python(?:3)?)\b/.test(
      header.subarray(0, readSync(descriptor, header, 0, header.length, 0)).toString('utf8'),
    )
  } finally {
    closeSync(descriptor)
  }
}

function physicalLines(bytes: Buffer): number {
  if (bytes.length === 0) return 0
  let newlines = 0
  for (const byte of bytes) if (byte === 10) newlines += 1
  return bytes[bytes.length - 1] === 10 ? newlines : newlines + 1
}

function candidate(path: string, isConfiguration = false): Candidate | null {
  if (!isConfiguration && !isCode(path)) return null
  const bytes = readFileSync(path)
  const lines = physicalLines(bytes)
  return {
    path,
    classification: lines > sourceLimit && isScenario(path, bytes.toString('utf8')) ? 'scenario' : 'source',
    lines,
  }
}

function sortedEntries(directory: string): Dirent[] {
  return readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
}

function collectPluginEntry(
  directory: string,
  name: string,
  entry: Dirent,
  candidates: Candidate[],
  visit: PluginVisitor,
): void {
  const next = join(directory, entry.name)
  const child = name === '' ? entry.name : `${name}/${entry.name}`
  if (name === '' && (entry.name === 'agents' || entry.name === 'dist')) return
  if (entry.isSymbolicLink()) throw new Error(`omp-build quality scope contains a symlink: plugins/omp-build/${child}`)
  if (entry.isDirectory()) {
    visit(next, child)
    return
  }
  if (!entry.isFile()) return
  const inspected = candidate(next, child in authoredConfigurationPaths)
  if (inspected !== null) candidates.push(inspected)
}

function collectToolEntry(
  root: string,
  toolsRoot: string,
  directory: string,
  entry: Dirent,
  candidates: Candidate[],
  visit: DirectoryVisitor,
): void {
  const path = join(directory, entry.name)
  const name = relative(toolsRoot, path)
  if (entry.isSymbolicLink()) {
    if (name.includes('omp-build'))
      throw new Error(`exclusive omp-build tool scope contains a symlink: ${relative(root, path)}`)
    return
  }
  if (entry.isDirectory()) {
    visit(path)
    return
  }
  if (!entry.isFile() || !name.includes('omp-build')) return
  const inspected = candidate(path)
  if (inspected !== null) candidates.push(inspected)
}

function collectPluginFiles(root: string): Candidate[] {
  const pluginRoot = join(root, 'plugins/omp-build')
  requireDirectory(pluginRoot, 'plugins/omp-build')
  const candidates: Candidate[] = []
  const visit: PluginVisitor = (directory, name) => {
    for (const entry of sortedEntries(directory)) collectPluginEntry(directory, name, entry, candidates, visit)
  }
  visit(pluginRoot, '')
  if (candidates.length === 0)
    throw new Error('expected omp-build scope contains no JS/TS/CJS/Python/Bash source files')
  return candidates
}

function collectExclusiveTools(root: string): Candidate[] {
  const toolsRoot = join(root, 'tools')
  requireDirectory(toolsRoot, 'tools')
  const candidates: Candidate[] = []
  const visit: DirectoryVisitor = (directory) => {
    for (const entry of sortedEntries(directory)) collectToolEntry(root, toolsRoot, directory, entry, candidates, visit)
  }
  visit(toolsRoot)
  if (candidates.length === 0)
    throw new Error('expected exclusive omp-build tool scope contains no JS/TS/CJS/Python/Bash source files')
  return candidates
}

function diagnostic(root: string, candidate: Candidate): string | null {
  const limit = candidate.classification === 'scenario' ? scenarioLimit : sourceLimit
  if (candidate.lines <= limit) return null
  return `${relative(root, candidate.path)}: ${candidate.lines} physical lines; ${candidate.classification} limit ${limit}`
}

function checkBiome(root: string, candidates: Candidate[]): void {
  const paths = candidates
    .filter((candidate) => extname(candidate.path) in biomeExtensions)
    .map((candidate) => relative(root, candidate.path))
  if (paths.length === 0) throw new Error('expected omp-build quality scope contains no JS/TS/CJS candidates for Biome')
  const executable = resolve(import.meta.dirname, '../node_modules/.bin/biome')
  if (!existsSync(executable)) throw new Error(`expected pinned Biome executable is missing: ${executable}`)
  const result = spawnSync(executable, ['check', '--error-on-warnings', '--reporter=json', ...paths], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status === null) throw new Error('pinned Biome did not return an exit status')
  if (result.status !== 0) process.exitCode = result.status
}

function check(root: string, withBiome: boolean): void {
  const candidates = [...collectPluginFiles(root), ...collectExclusiveTools(root)]
  const failures = candidates
    .map((candidate) => diagnostic(root, candidate))
    .filter((value): value is string => value !== null)
  if (failures.length > 0) throw new Error(`omp-build quality check failed:\n${failures.join('\n')}`)
  if (withBiome) checkBiome(root, candidates)
}

const options = optionsFromArgs(process.argv.slice(2))
check(options.root, options.withBiome)
