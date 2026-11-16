import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installRootStatus, replacedInstallRootMessage } from './install-root'
import type { OmpBuildExtensionApi } from './omp-controller'

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown
  const end = markdown.indexOf('\n---\n', 4)
  if (end === -1) return markdown
  return markdown.slice(end + 5)
}

async function readSkillBody(
  pi: OmpBuildExtensionApi,
  name: string,
  skillPath: string,
  installRoot: string,
  exists: (path: string) => boolean,
): Promise<string | undefined> {
  const install = installRootStatus(installRoot, exists)
  if (!install.present) {
    await pi.sendUserMessage(`/${name}: ${replacedInstallRootMessage(install.root, install.version)}`)
    return undefined
  }
  try {
    return readFileSync(skillPath, 'utf8')
  } catch (error) {
    await pi.sendUserMessage(
      `/${name}: cannot read its own body at ${skillPath} — ${error instanceof Error ? error.message : String(error)}. Reinstall omp-build.`,
    )
    return undefined
  }
}

export function registerSkillCommand(
  pi: OmpBuildExtensionApi,
  name: string,
  skill: string,
  description: string,
  requires: readonly string[],
  installRoot: string,
  skillsDir: string,
  exists: (path: string) => boolean,
): void {
  const skillDir = join(skillsDir, skill)
  pi.registerCommand(name, {
    description,
    handler: async (args) => {
      const raw = await readSkillBody(pi, name, join(skillDir, 'SKILL.md'), installRoot, exists)
      if (raw === undefined) return
      const missing = requires.filter((requiredSkill) => !exists(join(skillsDir, requiredSkill, 'SKILL.md')))
      const banner = missing.length
        ? `> **\`/${name}\` is partially installed**: ${missing.map((requiredSkill) => `\`${requiredSkill}\``).join(', ')} — no SKILL.md under ${skillsDir}. Every step of this body that names one of those stops there. Reinstall omp-build.\n`
        : ''
      const body = stripFrontmatter(raw).trim()
      const trimmedArgs = args.trim()
      await pi.sendUserMessage(
        [banner, body, '', `[Skill directory: ${skillDir}]`, trimmedArgs ? `\n${trimmedArgs}` : ''].join('\n').trim(),
      )
    },
  })
}
