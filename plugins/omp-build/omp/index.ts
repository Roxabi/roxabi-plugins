import {
  BUN_TEST_DENY_REASON,
  extractShellCommand,
  extractWriteContent,
  hasProjectContract,
  isBunTestBlocked,
  PROJECT_CONTRACT_FILES,
  scanSecurityContent,
  shouldBlockPrincipalSwitch,
} from './guards'

type ExtensionContext = {
  cwd: string
}

type ToolCallEvent = {
  toolName: string
  input: Record<string, unknown>
}

type ToolCallEventResult = {
  block?: boolean
  reason?: string
}

type ExtensionAPI = {
  on(
    event: 'tool_call',
    handler: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>,
  ): void
}

export default function ompBuildExtension(pi: ExtensionAPI): void {
  const warnedMissingContract = new Set<string>()

  pi.on('tool_call', async (event, ctx) => {
    if (!hasProjectContract(ctx.cwd)) {
      if (!warnedMissingContract.has(ctx.cwd)) {
        warnedMissingContract.add(ctx.cwd)
        console.warn(
          `omp-build: no project contract found (looked for: ${PROJECT_CONTRACT_FILES.join(', ')}) — guards disabled`,
        )
      }
      return
    }

    if (event.toolName === 'bash') {
      const command = extractShellCommand(event.input)
      if (!command) return

      if (isBunTestBlocked(command)) {
        return {
          block: true,
          reason: BUN_TEST_DENY_REASON,
        }
      }

      if (shouldBlockPrincipalSwitch(command, ctx.cwd)) {
        return {
          block: true,
          reason:
            'Principal freeze (pre): do not move principal off staging|main|master. Feature work → dedicated worktree (/R-setup-worktree or /R-dev #N).',
        }
      }
    }

    if (event.toolName === 'write' || event.toolName === 'edit') {
      const content = extractWriteContent(event.input)
      const violation = scanSecurityContent(content)
      if (violation) {
        return { block: true, reason: `Security check: ${violation}` }
      }
    }
  })

  // format hook + principal post-nudge: deferred. Never sendUserMessage on tool_result
  // (OMP treats that as a user turn and the agent may git-switch off the feature branch).
}
