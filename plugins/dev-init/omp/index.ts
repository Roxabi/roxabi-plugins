import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type ExtensionContext = {
  cwd: string
}

type ExtensionAPI = {
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

export default function devInitExtension(pi: ExtensionAPI): void {
  pi.registerCommand('dev-init', {
    description: 'Run the /dev-init Roxabi skill',
    handler: async (args) => {
      const skillDir = join(PLUGIN_ROOT, 'skills', 'dev-init')
      const skillPath = join(skillDir, 'SKILL.md')
      const body = stripFrontmatter(readFileSync(skillPath, 'utf8')).trim()
      const trimmedArgs = args.trim()
      const message = [
        body,
        '',
        `[Skill directory: ${skillDir}]`,
        'Paths: skill://shared-refs/harness-paths.md',
        trimmedArgs ? `\n${trimmedArgs}` : '',
      ]
        .join('\n')
        .trim()

      pi.sendUserMessage(message)
    },
  })
}
