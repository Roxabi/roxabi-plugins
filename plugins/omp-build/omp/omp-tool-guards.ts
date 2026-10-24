import type { ToolCallEvent } from '@oh-my-pi/pi-coding-agent'

import {
  BUN_TEST_DENY_REASON,
  evalGuard,
  extractShellCommand,
  extractWriteContent,
  hasProjectContract,
  isBunTestBlocked,
  PRINCIPAL_FREEZE_REASON,
  PROJECT_CONTRACT_FILES,
  scanSecurityContent,
  shouldBlockPrincipalSwitch,
} from './guards'
import type { OmpBuildExtensionApi } from './omp-controller'

type ToolInput = ToolCallEvent['input']

function isRecordInput(input: ToolInput): input is ToolInput & Record<string, unknown> {
  return typeof input === 'object' && input !== null
}

function warnMissingProjectContract(warnedMissingContract: Set<string>, cwd: string): boolean {
  if (hasProjectContract(cwd)) return false
  if (!warnedMissingContract.has(cwd)) {
    warnedMissingContract.add(cwd)
    console.warn(
      `omp-build: no project contract found (looked for: ${PROJECT_CONTRACT_FILES.join(', ')}) — guards disabled`,
    )
  }
  return true
}

function evaluateBashGuard(input: Record<string, unknown>, cwd: string) {
  const command = extractShellCommand(input)
  if (!command) return
  if (isBunTestBlocked(command)) return { block: true, reason: BUN_TEST_DENY_REASON }
  if (shouldBlockPrincipalSwitch(command, cwd)) return { block: true, reason: PRINCIPAL_FREEZE_REASON }
}

function evaluateOmpToolGuard(toolName: string, input: ToolInput, cwd: string) {
  if (!isRecordInput(input)) return
  if (toolName === 'bash') return evaluateBashGuard(input, cwd)
  if (toolName === 'eval') return evalGuard(input, cwd) ?? undefined
  if (toolName !== 'write' && toolName !== 'edit') return
  const violation = scanSecurityContent(extractWriteContent(input))
  return violation ? { block: true, reason: `Security check: ${violation}` } : undefined
}

export function installOmpToolGuards(pi: OmpBuildExtensionApi): void {
  const warnedMissingContract = new Set<string>()
  pi.on('tool_call', async (event, ctx) => {
    if (warnMissingProjectContract(warnedMissingContract, ctx.cwd)) return
    return evaluateOmpToolGuard(event.toolName, event.input, ctx.cwd)
  })
}
