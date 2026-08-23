import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const principalPre = require('../hooks/principal-branch-pre.cjs') as {
  shouldDenyPre: (cmd: string, cwd: string, deps?: { isPrincipalCwd?: (cwd: string) => boolean }) => boolean
}

const principalFreeze = require('../hooks/lib/principal-freeze.cjs') as {
  hasEscapeHatch: (env?: NodeJS.ProcessEnv) => boolean
  isPrincipalCwd: (cwd: string) => boolean
  principalHead: (
    cwd?: string,
  ) => { status: 'ok'; principal: string; branch: string } | { status: 'not_git' } | { status: 'probe_error' }
  isBaseBranch: (name: string | null | undefined) => boolean
}

export const SECURITY_PATTERNS = [
  {
    id: 'hardcoded-secret',
    pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    message: 'BLOCKED: Potential hardcoded secret detected',
  },
  {
    id: 'sql-injection',
    pattern: /`SELECT.*\$\{|`INSERT.*\$\{|`UPDATE.*\$\{|`DELETE.*\$\{/gi,
    message: 'BLOCKED: Potential SQL injection via template literal interpolation',
  },
  {
    id: 'command-injection',
    pattern: /exec\s*\(\s*`|spawn\s*\(\s*`|execSync\s*\(\s*`/gi,
    message: 'BLOCKED: Potential command injection via template literal',
  },
] as const

/** Max content bytes scanned by the OMP security hook (fail-open above this). */
export const SECURITY_SCAN_MAX_BYTES = 256_000

export function isBunTestBlocked(command: string): boolean {
  const hasBunTest = /(^|\s|&&|;|\|)bun test(\s|$)/.test(command)
  const hasBunRunTest = /bun run test/.test(command)
  return hasBunTest && !hasBunRunTest
}

export function shouldBlockPrincipalSwitch(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  deps?: { isPrincipalCwd?: (cwd: string) => boolean },
): boolean {
  if (principalFreeze.hasEscapeHatch(env)) return false
  return principalPre.shouldDenyPre(command, cwd, deps)
}

export function extractWriteContent(input: Record<string, unknown>): string {
  const content = input.content ?? input.new_string ?? input.newString ?? input.new_str ?? input.input ?? ''
  return typeof content === 'string' ? content : ''
}

export function extractShellCommand(input: Record<string, unknown>): string {
  const command = input.command ?? input.cmd ?? ''
  return typeof command === 'string' ? command : ''
}

export function scanSecurityContent(content: string): string | null {
  if (!content) return null
  if (Buffer.byteLength(content, 'utf8') > SECURITY_SCAN_MAX_BYTES) return null

  for (const rule of SECURITY_PATTERNS) {
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(content)) {
      return rule.message
    }
    rule.pattern.lastIndex = 0
  }

  return null
}

export function principalPostNudge(cwd: string = process.cwd()): string | null {
  if (principalFreeze.hasEscapeHatch()) return null

  const head = principalFreeze.principalHead(cwd)
  if (head.status !== 'ok') return null
  if (principalFreeze.isBaseBranch(head.branch)) return null

  return (
    'Principal freeze (post): principal HEAD is not on staging|main|master. ' +
    `Restore: git -C <principal> switch staging|main. Currently: ${head.branch} @ ${head.principal}`
  )
}

export { principalFreeze }
