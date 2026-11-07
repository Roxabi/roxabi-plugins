import type { ToolCallEvent, ToolCallEventResult, ToolInfo } from '@oh-my-pi/pi-coding-agent'
import { FRAMING_SUBMIT_TOOL } from '../roxabi/feature-framing-contract.ts'

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
import { featureOperationReadOnly } from './omp-feature-composition.ts'
import { FRAMING_SUBMIT_SOURCE_PATH } from './omp-framing-runtime.ts'

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

const READ_ONLY_BUILTINS = new Set(['read', 'grep', 'glob'])

/** Exact provenance only: a same-named MCP, extension or SDK tool is never the admitted one. */
function admittedReadOnlyTool(tool: ToolInfo): boolean {
  const source = tool.sourceInfo
  if (READ_ONLY_BUILTINS.has(tool.name)) return source.source === 'builtin' && source.path === `<builtin:${tool.name}>`
  return (
    tool.name === FRAMING_SUBMIT_TOOL && source.source === 'extension' && source.path === FRAMING_SUBMIT_SOURCE_PATH
  )
}

/** Exactly one registered tool of that name, with admitted provenance; unreadable metadata denies. */
function admittedDuringFraming(pi: OmpBuildExtensionApi, toolName: string): boolean {
  try {
    const matches = pi.getAllTools().filter((tool) => tool.name === toolName)
    return matches.length === 1 && matches[0] !== undefined && admittedReadOnlyTool(matches[0])
  } catch {
    return false
  }
}

/**
 * While a `/feature` intake is unclassified or a framing lease (live or revoked) holds the owner slot,
 * every context admits only built-in read/grep/glob and the framing submit tool.
 */
function evaluateFramingAdmission(pi: OmpBuildExtensionApi, toolName: string): ToolCallEventResult | undefined {
  if (!featureOperationReadOnly(pi) || admittedDuringFraming(pi, toolName)) return
  return {
    block: true,
    reason: `omp-build framing is read-only: ${toolName} is not admitted; only built-in read, grep, glob and ${FRAMING_SUBMIT_TOOL} run until framing ends.`,
  }
}

export function installOmpToolGuards(pi: OmpBuildExtensionApi): void {
  const warnedMissingContract = new Set<string>()
  pi.on('tool_call', async (event, ctx) => {
    const framing = evaluateFramingAdmission(pi, event.toolName)
    if (framing !== undefined) return framing
    if (warnMissingProjectContract(warnedMissingContract, ctx.cwd)) return
    return evaluateOmpToolGuard(event.toolName, event.input, ctx.cwd)
  })
}
