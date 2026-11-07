import { ticketOfSubject } from '../skills/feature/epic-claims.ts'
import { titleType } from '../skills/feature/epic-naming.ts'
import type { GitRunner } from './workflow-checkout.ts'

export async function integrationLineage(input: {
  git: GitRunner
  cwd: string
  base: string
  expectedBase: string
  initialHead: string
  head: string
  target: string
  childCommits: string[]
}): Promise<{ ok: true; commits: string[]; paths: string[] } | { ok: false; reason: string }> {
  const { git, cwd, head: expectedHead } = input
  const [head, status, branch, base, lineage] = await Promise.all([
    git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']),
    git(cwd, ['status', '--porcelain']),
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['rev-parse', '--verify', `origin/${input.base}^{commit}`]),
    git(cwd, ['rev-list', '--first-parent', '--reverse', `${input.initialHead}..${expectedHead}`]),
  ])
  if (
    head.code !== 0 ||
    head.stdout.trim() !== expectedHead ||
    status.code !== 0 ||
    status.stdout.trim() !== '' ||
    branch.code !== 0 ||
    branch.stdout.trim() !== 'HEAD' ||
    base.code !== 0 ||
    base.stdout.trim() !== input.expectedBase ||
    lineage.code !== 0
  )
    return { ok: false, reason: 'integration-code-unobserved' }

  const commits = lineage.stdout.split('\n').filter(Boolean)
  const paths = new Set<string>()
  let parent = input.initialHead
  const ticket = Number(input.target.slice(input.target.lastIndexOf('#') + 1))
  const validCommit = (parts: string[], sha: string, changed: string, subject: string): boolean => {
    if (parts[0] !== sha || parts[1] !== parent) return false
    if (parts.length === 3) return parts[2] !== undefined && input.childCommits.includes(parts[2])
    return (
      parts.length === 2 &&
      changed.split('\n').filter(Boolean).length !== 0 &&
      Number.isSafeInteger(ticket) &&
      ticket > 0 &&
      titleType(subject.trim()) !== null &&
      ticketOfSubject(subject.trim()) === ticket
    )
  }
  for (const sha of commits) {
    const [parents, changed, subject] = await Promise.all([
      git(cwd, ['rev-list', '--parents', '-n1', sha]),
      git(cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', sha]),
      git(cwd, ['show', '-s', '--format=%s', sha]),
    ])
    const parts = parents.stdout.trim().split(/\s+/)
    if (
      parents.code !== 0 ||
      changed.code !== 0 ||
      subject.code !== 0 ||
      !validCommit(parts, sha, changed.stdout, subject.stdout)
    )
      return { ok: false, reason: 'integration-lineage-unverified' }
    for (const path of changed.stdout.split('\n').filter(Boolean)) paths.add(path)
    parent = sha
  }
  if (parent !== expectedHead) return { ok: false, reason: 'integration-lineage-unverified' }
  return { ok: true, commits, paths: [...paths] }
}
