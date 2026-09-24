import { existsSync, readFileSync } from 'node:fs'
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

const SKILLS_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills')

/**
 * Every slash command this extension owns: one skill body, dumped verbatim.
 *
 * `requires` names the plugin-local skills that body invokes by name. They are not
 * commands — the model reaches them with `Skill(skill: "<name>")` — so nothing else
 * would notice a partial install: `/feature` would dump a body whose §6.4 calls a
 * review that resolves nowhere, three steps into a live ticket. Checked at
 * invocation, reported in the conversation, never fatal (mode 1 does not need them).
 */
const SKILL_COMMANDS = [
  {
    name: 'feature',
    description:
      'Run one OMP feature cycle — issue, branch proposal, operator /wt, implement, bounded review/fix, land',
    requires: ['dev-review', 'fix'],
  },
  {
    // The optional tail (#495). Offered after a ticket lands, never chained:
    // `/feature` prints the offer and stops, and neither body is reachable from
    // the review→fix loop.
    name: 'promote',
    description: 'Promote staging→main — pre-flight, version, changelog, PR, tag',
    requires: [],
  },
  {
    name: 'cleanup',
    description: 'Clean merged branches, worktrees and remotes after verification',
    requires: [],
  },
  {
    name: 'ci-watch',
    description: 'Watch every check on a PR head, then the merge, until the script deadline',
    requires: [],
  },
] as const

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown
  const end = markdown.indexOf('\n---\n', 4)
  if (end === -1) return markdown
  return markdown.slice(end + 5)
}

export default function ompBuildExtension(
  pi: ExtensionAPI,
  { exists = existsSync }: { exists?: (path: string) => boolean } = {},
): void {
  // User-only by construction, on the one lane that exists: `registerCommand` is
  // the slash lane, `registerTool` is the LLM one (omp://extensions.md), and the
  // model cannot reach a command. That alone is the property. A body's
  // `disable-model-invocation` is not a second gate — omp normalises it to `hide`,
  // which omits the skill from the prompt listing while `skill://<name>` and
  // `/skill:<name>` still reach it (measured on omp 18.2.9).
  //
  // No `rewriteHarnessPaths` here: nothing this plugin dumps carries a
  // `${CLAUDE_*}` path token to expand — agent bodies *and* skill bodies, the
  // surface these commands added, are held to that by
  // `agents/__tests__/roster.test.ts` ("cites no plugin-root token").
  for (const { name, description, requires } of SKILL_COMMANDS) {
    const skillDir = join(SKILLS_DIR, name)
    pi.registerCommand(name, {
      description,
      handler: async (args) => {
        const skillPath = join(skillDir, 'SKILL.md')
        let raw: string
        try {
          raw = readFileSync(skillPath, 'utf8')
        } catch (error) {
          // omp catches a handler throw and reports it on a channel the operator
          // may not be watching: a partial install would produce no turn and no
          // visible error at all. Say it in the conversation, naming the path.
          pi.sendUserMessage(
            `/${name}: cannot read its own body at ${skillPath} — ${error instanceof Error ? error.message : String(error)}. Reinstall omp-build.`,
          )
          return
        }
        const missing = requires.filter((skill) => !exists(join(SKILLS_DIR, skill, 'SKILL.md')))
        const banner = missing.length
          ? `> **\`/${name}\` is partially installed**: ${missing.map((skill) => `\`${skill}\``).join(', ')} — no SKILL.md under ${SKILLS_DIR}. Every step of this body that names one of those stops there. Reinstall omp-build.\n`
          : ''
        const body = stripFrontmatter(raw).trim()
        const trimmedArgs = args.trim()
        pi.sendUserMessage(
          [banner, body, '', `[Skill directory: ${skillDir}]`, trimmedArgs ? `\n${trimmedArgs}` : ''].join('\n').trim(),
        )
      },
    })
  }

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
