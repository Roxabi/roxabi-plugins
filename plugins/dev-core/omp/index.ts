import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  extractShellCommand,
  extractWriteContent,
  isBunTestBlocked,
  rewriteHarnessPaths,
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
  on(event: 'tool_result', handler: (event: { toolName: string }, ctx: ExtensionContext) => Promise<void>): void
  registerCommand(
    name: string,
    options: {
      description?: string
      handler: (args: string, ctx: ExtensionContext) => Promise<void>
    },
  ): void
  sendUserMessage: (content: string, options?: { deliverAs?: 'steer' | 'followUp' }) => void
}

const __filename = fileURLToPath(import.meta.url)
const PLUGIN_ROOT = dirname(dirname(__filename))

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown
  const end = markdown.indexOf('\n---\n', 4)
  if (end === -1) return markdown
  return markdown.slice(end + 5)
}

function readSkillBody(skillName: string): { body: string; skillDir: string } {
  const skillDir = join(PLUGIN_ROOT, 'skills', skillName)
  const skillPath = join(skillDir, 'SKILL.md')
  const raw = readFileSync(skillPath, 'utf8')
  return { body: rewriteHarnessPaths(stripFrontmatter(raw).trim(), skillDir, PLUGIN_ROOT), skillDir }
}

function registerSkillCommand(pi: ExtensionAPI, skillName: string): void {
  pi.registerCommand(skillName, {
    description: `Run the /${skillName} Roxabi skill`,
    handler: async (args) => {
      const { body, skillDir } = readSkillBody(skillName)
      const trimmedArgs = args.trim()
      const message = [body, '', `[Skill directory: ${skillDir}]`, trimmedArgs ? `\n${trimmedArgs}` : '']
        .join('\n')
        .trim()

      pi.sendUserMessage(message)
    },
  })
}

export default function devCoreExtension(pi: ExtensionAPI): void {
  registerSkillCommand(pi, 'dev')
  registerSkillCommand(pi, 'ship')
  registerSkillCommand(pi, 'dev-plan')
  registerSkillCommand(pi, 'dev-review')
  registerSkillCommand(pi, 'dev-checkup')

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName === 'bash') {
      const command = extractShellCommand(event.input)
      if (!command) return

      if (isBunTestBlocked(command)) {
        return {
          block: true,
          reason: 'Use bun run test (Vitest), not bun test (Bun runner)',
        }
      }

      if (shouldBlockPrincipalSwitch(command, ctx.cwd)) {
        return {
          block: true,
          reason:
            'Principal freeze (pre): do not move principal off staging|main|master. Feature work → dedicated worktree (/setup-worktree or /dev #N).',
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
