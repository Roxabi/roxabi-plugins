import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  registerCommand(
    name: string,
    options: {
      description?: string
      handler: (args: string, ctx: ExtensionContext) => Promise<void>
    },
  ): void
  sendUserMessage: (content: string, options?: { deliverAs?: 'steer' | 'followUp' }) => void
}

const FEATURE_SKILL_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills', 'feature')

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown
  const end = markdown.indexOf('\n---\n', 4)
  if (end === -1) return markdown
  return markdown.slice(end + 5)
}

export default function ompBuildExtension(pi: ExtensionAPI): void {
  // Slash-only by construction: `registerCommand` is the slash lane, `registerTool`
  // is the LLM one (omp://extensions.md). The model cannot reach a command, and
  // `disable-model-invocation` in the SKILL.md keeps `Skill()` and autoload off it
  // too, so `/feature` is user-driven on both lanes.
  //
  // No `rewriteHarnessPaths` here: omp-build expands no `${CLAUDE_*}` token
  // anywhere (README § Guards, agents/__tests__/roster.test.ts), so dumping the
  // body verbatim plus its directory is the whole contract.
  pi.registerCommand('feature', {
    description: 'Run one OMP feature cycle — frame in ω, or build the named ticket',
    handler: async (args) => {
      const body = stripFrontmatter(readFileSync(join(FEATURE_SKILL_DIR, 'SKILL.md'), 'utf8')).trim()
      const trimmedArgs = args.trim()
      pi.sendUserMessage(
        [body, '', `[Skill directory: ${FEATURE_SKILL_DIR}]`, trimmedArgs ? `\n${trimmedArgs}` : ''].join('\n').trim(),
      )
    },
  })

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
