import type { GitDep } from './pin-swap-contract'

type SourcesSection = { inSources: boolean; currentName: string | null }
type RewriteSection = { inSources: boolean; inPkgBlock: boolean }

function sourcesSection(trimmed: string): SourcesSection {
  const subTable = trimmed.match(/^\[tool\.uv\.sources\.([^\]]+)\]$/)
  if (subTable) return { inSources: true, currentName: subTable[1] }
  if (trimmed === '[tool.uv.sources]') return { inSources: true, currentName: null }
  return { inSources: false, currentName: null }
}

function inlineGitDep(trimmed: string): GitDep | null {
  const inlineMatch = trimmed.match(/^(\S+)\s*=\s*\{([^}]*)\}/)
  if (!inlineMatch) return null
  const gitMatch = inlineMatch[2].match(/git\s*=\s*["']([^"']+)["']/)
  const branchMatch = inlineMatch[2].match(/branch\s*=\s*["']([^"']+)["']/)
  if (!gitMatch || !branchMatch) return null
  return { name: inlineMatch[1], source: { git: gitMatch[1], branch: branchMatch[1] } }
}

function sourceField(trimmed: string, name: 'git' | 'branch'): string | null {
  return trimmed.match(new RegExp(`^${name}\\s*=\\s*["']([^"']+)["']`))?.[1] ?? null
}

function rewriteSection(trimmed: string, pkgName: string, inSources: boolean): RewriteSection {
  if (trimmed === '[tool.uv.sources]') return { inSources: true, inPkgBlock: false }
  if (trimmed === `[tool.uv.sources.${pkgName}]`) return { inSources: true, inPkgBlock: true }
  if (inSources && trimmed.startsWith('[tool.uv.sources.')) return { inSources: true, inPkgBlock: false }
  return { inSources: false, inPkgBlock: false }
}

function rewriteInlineSource(line: string, pkgName: string, tag: string): string | null {
  const inlineRegex = new RegExp(`^(\\s*${pkgName}\\s*=\\s*\\{[^}]*)branch\\s*=\\s*["'][^"']*["']([^}]*\\})`)
  return inlineRegex.test(line) ? line.replace(/branch\s*=\s*["'][^"']*["']/, `tag = "${tag}"`) : null
}

function rewriteSubTableBranch(line: string, inPkgBlock: boolean, tag: string): string | null {
  if (!inPkgBlock || !/^\s*branch\s*=/.test(line)) return null
  const indent = line.match(/^(\s*)/)?.[1] ?? ''
  return `${indent}tag = "${tag}"`
}

export function parseUvGitDeps(pyprojectText: string): GitDep[] {
  const deps: GitDep[] = []
  let inSources = false
  let currentName: string | null = null
  let currentGit: string | null = null
  let currentBranch: string | null = null

  const flushBlock = () => {
    if (currentName && currentGit && currentBranch) {
      deps.push({ name: currentName, source: { git: currentGit, branch: currentBranch } })
    }
    currentName = null
    currentGit = null
    currentBranch = null
  }

  for (const line of pyprojectText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      flushBlock()
      const section = sourcesSection(trimmed)
      inSources = section.inSources
      currentName = section.currentName
      continue
    }
    if (!inSources) continue

    const inline = currentName ? null : inlineGitDep(trimmed)
    if (inline) {
      deps.push(inline)
      continue
    }
    if (!currentName) continue

    const git = sourceField(trimmed, 'git')
    if (git) {
      currentGit = git
      continue
    }
    const branch = sourceField(trimmed, 'branch')
    if (branch) currentBranch = branch
  }

  flushBlock()
  return deps
}

export function readLockedSha(uvLockText: string, pkgName: string): string | null {
  const blocks = uvLockText.split(/(?=\[\[package\]\])/g)
  for (const block of blocks) {
    const nameMatch = block.match(/^name\s*=\s*["']([^"']+)["']/m)
    if (!nameMatch) continue
    const blockName = nameMatch[1].toLowerCase().replace(/-/g, '_')
    const target = pkgName.toLowerCase().replace(/-/g, '_')
    if (blockName !== target) continue
    const revMatch = block.match(/rev\s*=\s*["']([a-f0-9]{40})["']/)
    if (revMatch) return revMatch[1]
  }
  return null
}

export function rewritePyproject(pyprojectText: string, pkgName: string, tag: string): string {
  const result: string[] = []
  let inSources = false
  let inPkgBlock = false
  let foundAndRewroteInline = false

  for (const line of pyprojectText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) {
      const section = rewriteSection(trimmed, pkgName, inSources)
      inSources = section.inSources
      inPkgBlock = section.inPkgBlock
      result.push(line)
      continue
    }

    const inline = inSources && !foundAndRewroteInline ? rewriteInlineSource(line, pkgName, tag) : null
    if (inline) {
      result.push(inline)
      foundAndRewroteInline = true
      continue
    }

    const subTable = rewriteSubTableBranch(line, inPkgBlock, tag)
    if (subTable) {
      result.push(subTable)
      continue
    }
    result.push(line)
  }
  return result.join('\n')
}
