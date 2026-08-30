import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rewriteHarnessPaths } from './paths'

type ExtensionAPI = {
  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string) => Promise<void>
    },
  ): void
  sendUserMessage: (content: string, options?: { deliverAs?: 'steer' | 'followUp' }) => void
}

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SKILL_NAME = 'issue-triage'

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown
  const end = markdown.indexOf('\n---\n', 4)
  if (end === -1) return markdown
  return markdown.slice(end + 5)
}

function readSkillBody(): { body: string; skillDir: string } {
  const skillDir = join(PLUGIN_ROOT, 'skills', SKILL_NAME)
  const raw = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
  return { body: rewriteHarnessPaths(stripFrontmatter(raw).trim(), skillDir, PLUGIN_ROOT), skillDir }
}

export default function issueTriageExtension(pi: ExtensionAPI): void {
  pi.registerCommand(SKILL_NAME, {
    description: 'Triage/create GitHub issues — labels, blocked-by, parent/child',
    handler: async (args) => {
      const { body, skillDir } = readSkillBody()
      const trimmedArgs = args.trim()
      const message = [body, '', `[Skill directory: ${skillDir}]`, trimmedArgs ? `\n${trimmedArgs}` : '']
        .join('\n')
        .trim()
      pi.sendUserMessage(message)
    },
  })
}
