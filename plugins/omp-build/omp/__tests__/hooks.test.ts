import type * as NodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  extractWriteContent,
  hasProjectContract,
  isBunTestBlocked,
  SECURITY_SCAN_MAX_BYTES,
  scanSecurityContent,
  shouldBlockPrincipalSwitch,
} from '../guards'
import ompBuildExtension from '../index'

// The only fs call intercepted is the command handler's own body read, and only
// while `skillRead.fail` is set: everything else — including this file's temp
// dirs — goes straight through to the real module.
const skillRead = vi.hoisted(() => ({ fail: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const readFileSync = ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
    if (skillRead.fail && String(path).endsWith('SKILL.md')) {
      throw new Error(`ENOENT: no such file or directory, open '${String(path)}'`)
    }
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
  }) as typeof actual.readFileSync
  return { ...actual, readFileSync, default: { ...actual, readFileSync } }
})

describe('OMP omp-build hooks', () => {
  describe('project contract', () => {
    it('accepts .dev/stack.yml alone', () => {
      expect(hasProjectContract('/repo', (path) => path === '/repo/.dev/stack.yml')).toBe(true)
    })

    it('accepts .dev/dev-core.yml alone', () => {
      expect(hasProjectContract('/repo', (path) => path === '/repo/.dev/dev-core.yml')).toBe(true)
    })

    it('ignores .claude/stack.yml', () => {
      expect(hasProjectContract('/repo', (path) => path === '/repo/.claude/stack.yml')).toBe(false)
    })

    it('ignores the retired pre-.dev contract locations', () => {
      for (const rel of ['stack.yml', '.omp/stack.yml', 'dev-core.yml', '.omp/dev-core.yml']) {
        expect(hasProjectContract('/repo', (path) => path === `/repo/${rel}`)).toBe(false)
      }
    })

    it('is false when no contract exists', () => {
      expect(hasProjectContract('/repo', () => false)).toBe(false)
    })
  })

  describe('bun-test guard', () => {
    it('blocks bare bun test', () => {
      expect(isBunTestBlocked('bun test')).toBe(true)
      expect(isBunTestBlocked('cd apps/api && bun test src')).toBe(true)
    })

    it('allows bun run test', () => {
      expect(isBunTestBlocked('bun run test')).toBe(false)
      expect(isBunTestBlocked('cd apps/api && bun run test')).toBe(false)
    })
  })

  describe('principal freeze pre', () => {
    it('denies git switch feat/foo on principal cwd', () => {
      const principalCwd = '/repo/principal'
      const denied = shouldBlockPrincipalSwitch(
        'git switch feat/foo',
        principalCwd,
        {},
        {
          isPrincipalCwd: (cwd) => cwd === principalCwd,
        },
      )
      expect(denied).toBe(true)
    })

    it('allows switch on non-principal cwd', () => {
      const denied = shouldBlockPrincipalSwitch(
        'git switch feat/foo',
        '/repo/feature-wt',
        {},
        {
          isPrincipalCwd: () => false,
        },
      )
      expect(denied).toBe(false)
    })

    it('honors DEV_CORE_ALLOW_PRINCIPAL_SWITCH escape hatch', () => {
      const principalCwd = '/repo/principal'
      const denied = shouldBlockPrincipalSwitch(
        'git switch feat/foo',
        principalCwd,
        { DEV_CORE_ALLOW_PRINCIPAL_SWITCH: '1' },
        { isPrincipalCwd: (cwd) => cwd === principalCwd },
      )
      expect(denied).toBe(false)
    })
  })

  // `rewriteHarnessPaths` is deliberately absent. `/feature` *does* inject a
  // SKILL.md body, so the justification is no longer "this plugin dumps none":
  // it is that nothing it dumps carries a `${CLAUDE_*}` path token to expand,
  // asserted over agent bodies and skill bodies alike by
  // `agents/__tests__/roster.test.ts` ("cites no plugin-root token").

  describe('extractWriteContent', () => {
    it('reads OMP edit hashline from input', () => {
      expect(extractWriteContent({ input: '+const api_key = "abcdefgh12345"' })).toContain('api_key')
    })
  })

  // Assembled rather than spelled out: a literal credential in this file would
  // trip the repo's own pre-write security hook before the test could run.
  const CREDENTIAL = `const api_key = ${JSON.stringify('hunter2-hunter2')}\n`
  const SECRET_REASON = 'BLOCKED: Potential hardcoded secret detected'

  describe('security scan ceiling', () => {
    it('catches a credential below the ceiling', () => {
      const payload = CREDENTIAL + 'x'.repeat(1024)
      expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(SECURITY_SCAN_MAX_BYTES)
      expect(scanSecurityContent(payload)).toBe(SECRET_REASON)
    })

    it('scans a payload sitting exactly on the ceiling', () => {
      const payload = CREDENTIAL + 'x'.repeat(SECURITY_SCAN_MAX_BYTES - Buffer.byteLength(CREDENTIAL, 'utf8'))
      expect(Buffer.byteLength(payload, 'utf8')).toBe(SECURITY_SCAN_MAX_BYTES)
      expect(scanSecurityContent(payload)).toBe(SECRET_REASON)
    })

    it('fails open one byte above the ceiling, carrying the same credential', () => {
      const payload = CREDENTIAL + 'x'.repeat(SECURITY_SCAN_MAX_BYTES + 1 - Buffer.byteLength(CREDENTIAL, 'utf8'))
      expect(Buffer.byteLength(payload, 'utf8')).toBe(SECURITY_SCAN_MAX_BYTES + 1)
      expect(scanSecurityContent(payload)).toBeNull()
    })
  })

  describe('extension interceptor', () => {
    type ToolCallHandler = (
      event: { toolName: string; input: Record<string, unknown> },
      ctx: { cwd: string },
    ) => Promise<{ block?: boolean; reason?: string } | undefined>

    let handler: ToolCallHandler
    let contractCwd: string
    let bareCwd: string

    beforeAll(() => {
      contractCwd = mkdtempSync(join(tmpdir(), 'omp-build-contract-'))
      mkdirSync(join(contractCwd, '.dev'))
      writeFileSync(join(contractCwd, '.dev', 'stack.yml'), 'package_manager: bun\n')
      bareCwd = mkdtempSync(join(tmpdir(), 'omp-build-bare-'))

      let captured: ToolCallHandler | undefined
      ompBuildExtension({
        on: (_event, fn) => {
          captured = fn as ToolCallHandler
        },
        registerCommand: () => {},
        sendUserMessage: () => {},
      })
      if (!captured) throw new Error('extension registered no tool_call handler')
      handler = captured
    })

    afterAll(() => {
      rmSync(contractCwd, { recursive: true, force: true })
      rmSync(bareCwd, { recursive: true, force: true })
    })

    it('blocks bare bun test', async () => {
      const verdict = await handler({ toolName: 'bash', input: { command: 'bun test' } }, { cwd: contractCwd })
      expect(verdict?.block).toBe(true)
      expect(verdict?.reason).toMatch(/bun test/i)
    })

    it('lets bun run test through', async () => {
      // The principal probe shells out to git. The escape hatch pins this
      // assertion to the bun-test branch, so the unit project never forks.
      vi.stubEnv('DEV_CORE_ALLOW_PRINCIPAL_SWITCH', '1')
      try {
        const verdict = await handler({ toolName: 'bash', input: { command: 'bun run test' } }, { cwd: contractCwd })
        expect(verdict).toBeUndefined()
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it('blocks a write carrying a credential', async () => {
      const verdict = await handler({ toolName: 'write', input: { content: CREDENTIAL } }, { cwd: contractCwd })
      expect(verdict?.block).toBe(true)
      expect(verdict?.reason).toBe(`Security check: ${SECRET_REASON}`)
    })

    it('blocks an edit carrying a credential in new_string', async () => {
      // `edit` is the dominant tool in an agent loop; narrowing the branch to
      // `write` alone used to leave every test green (PR #531 review).
      const verdict = await handler({ toolName: 'edit', input: { new_string: CREDENTIAL } }, { cwd: contractCwd })
      expect(verdict?.block).toBe(true)
      expect(verdict?.reason).toBe(`Security check: ${SECRET_REASON}`)
    })

    it('blocks an edit carrying a credential in an OMP hashline', async () => {
      const verdict = await handler({ toolName: 'edit', input: { input: `+${CREDENTIAL}` } }, { cwd: contractCwd })
      expect(verdict?.block).toBe(true)
      expect(verdict?.reason).toBe(`Security check: ${SECRET_REASON}`)
    })

    it('blocks a bare bun test arriving under the cmd alias', async () => {
      const verdict = await handler({ toolName: 'bash', input: { cmd: 'bun test' } }, { cwd: contractCwd })
      expect(verdict?.block).toBe(true)
      expect(verdict?.reason).toMatch(/bun test/i)
    })

    it('lets a clean write through', async () => {
      const verdict = await handler(
        { toolName: 'write', input: { content: 'export const answer = 42\n' } },
        { cwd: contractCwd },
      )
      expect(verdict).toBeUndefined()
    })

    it('goes no-op, warning once, without a project contract', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        expect(await handler({ toolName: 'bash', input: { command: 'bun test' } }, { cwd: bareCwd })).toBeUndefined()
        expect(await handler({ toolName: 'bash', input: { command: 'bun test' } }, { cwd: bareCwd })).toBeUndefined()
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls[0]?.[0]).toContain('omp-build')
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe('slash commands', () => {
    type Command = { description?: string; handler: (args: string, ctx: { cwd: string }) => Promise<void> }

    const commands = new Map<string, Command>()
    const sent: string[] = []

    beforeAll(() => {
      ompBuildExtension({
        on: () => {},
        registerCommand: (name, options) => {
          commands.set(name, options as Command)
        },
        sendUserMessage: (content) => {
          sent.push(content)
        },
      })
    })

    it('registers exactly the three skill commands', () => {
      // The tail (#495) is reachable by slash and by nothing else. Dropping a
      // registration makes `/promote` or `/cleanup` unreachable while the body
      // still sits on disk looking installed.
      expect([...commands.keys()].sort()).toEqual(['cleanup', 'feature', 'promote'])
    })

    // Built the way the source builds it — two levels up from the module, then
    // `skills/feature` — instead of matched against `plugins/omp-build/…`: the
    // monorepo layout is not the contract, and a marketplace install is a
    // byte-identical copy at another path.
    const skillDir = resolve(import.meta.dirname, '..', '..', 'skills', 'feature')

    it('dumps the skill body, frontmatter stripped, with its directory and the args', async () => {
      await commands.get('feature')?.handler('#493', { cwd: '/repo' })
      const message = sent.at(-1)
      expect(message).toBeDefined()
      // Frontmatter in the conversation would be noise the model reads as content.
      expect(message).not.toContain('disable-model-invocation')
      expect(message).toContain('# Feature')
      expect(message?.endsWith('#493')).toBe(true)

      const printed = /\[Skill directory: (.+)]/.exec(message ?? '')?.[1]
      expect(printed).toBe(skillDir)
      // §2 tells the agent to `import(`${SKILL_DIR}/entry.js`)`. A directory that
      // does not carry the seam is a dead instruction, wherever it resolves.
      expect(existsSync(join(printed ?? '', 'entry.js'))).toBe(true)
    })

    it('says so in the conversation when its own body cannot be read', async () => {
      // omp catches a handler throw and reports it on a channel the operator may
      // not be watching: a partial install would otherwise produce no turn at all.
      skillRead.fail = true
      try {
        await commands.get('feature')?.handler('', { cwd: '/repo' })
      } finally {
        skillRead.fail = false
      }
      const message = sent.at(-1)
      expect(message).toContain('cannot read its own body')
      expect(message).toContain(join(skillDir, 'SKILL.md'))
      expect(message).not.toContain('# Feature')
    })

    it.each(['promote', 'cleanup'])('dumps the %s body with its own skill directory', async (name) => {
      await commands.get(name)?.handler('--dry-run', { cwd: '/repo' })
      const message = sent.at(-1)
      expect(message).toBeDefined()
      // Both tail bodies *discuss* `disable-model-invocation` in prose, so the
      // keyword cannot stand in for "frontmatter stripped". The boundary can:
      // a stripped body starts at its H1 and carries no `version:` key.
      expect(message?.startsWith('# ')).toBe(true)
      expect(message).not.toMatch(/^version:/m)
      expect(message?.endsWith('--dry-run')).toBe(true)

      const printed = /\[Skill directory: (.+)]/.exec(message ?? '')?.[1]
      expect(printed).toBe(resolve(import.meta.dirname, '..', '..', 'skills', name))
      // Each tail body instructs by `skill://<skill>/<file>`. Two things must
      // hold for that to resolve: `<skill>` is a skill — a directory carrying a
      // SKILL.md, which is what the harness looks a name up in — and the asset
      // exists inside it. `skill://shared/lib.sh` satisfied only the second:
      // `skills/shared/` is a plain directory of this plugin, so the URL named a
      // file that is really there through a namespace that cannot reach it.
      //
      // The assertion this replaces, `existsSync(<printed>/SKILL.md)`, restated
      // the precondition: the body under test was just read from that file, so it
      // could not fail while the handler worked at all.
      const skillsDir = resolve(import.meta.dirname, '..', '..', 'skills')
      const cited = [...(message ?? '').matchAll(/skill:\/\/([a-z0-9-]+)\/([\w./-]+)/g)]
      expect(cited.length).toBeGreaterThan(0)
      const unresolvable = cited
        .filter(
          ([, skill, rel]) =>
            !existsSync(join(skillsDir, skill, 'SKILL.md')) || !existsSync(join(skillsDir, skill, rel)),
        )
        .map(([url]) => url)
      expect(unresolvable).toEqual([])
    })

    it('keeps both tail bodies out of the review loop, in the text the model receives', async () => {
      // The offered-tail contract is only real if it survives into the dumped
      // body — the command handler strips frontmatter, so a claim made only in
      // `disable-model-invocation` reaches nobody.
      for (const name of ['promote', 'cleanup']) {
        await commands.get(name)?.handler('', { cwd: '/repo' })
        const message = sent.at(-1) ?? ''
        expect(message).toContain('never run on its own initiative')
        expect(message).toContain('review→fix loop')
      }
    })

    it('dumps no install banner while the skills mode 2 names are all present', async () => {
      await commands.get('feature')?.handler('#494', { cwd: '/repo' })
      const message = sent.at(-1) ?? ''
      expect(message.startsWith('# Feature')).toBe(true)
      expect(message).not.toContain('partially installed')
    })

    it('says which of them is missing, instead of dumping a body that cannot run', async () => {
      // The failure it catches: `skills/dev-review/` absent from the install.
      // Nothing else observes that — `/feature` still reads its own body, still
      // prints its own directory, and §6.4 calls a review that resolves nowhere.
      const partial = new Map<string, Command>()
      const messages: string[] = []
      ompBuildExtension(
        {
          on: () => {},
          registerCommand: (name, options) => {
            partial.set(name, options as Command)
          },
          sendUserMessage: (content) => {
            messages.push(content)
          },
        },
        { exists: (path) => !path.includes(`${sep}dev-review${sep}`) },
      )
      await partial.get('feature')?.handler('#494', { cwd: '/repo' })
      const message = messages.at(-1) ?? ''
      // The banner is the first line; the body below it names `fix` all over §6,
      // so the whole message cannot say which one was found missing.
      const banner = message.split('\n')[0] ?? ''
      expect(banner).toContain('partially installed')
      expect(banner).toContain('`dev-review`')
      expect(banner).not.toContain('`fix`')
      // The body still arrives: mode 1 needs none of these.
      expect(message).toContain('# Feature')
      expect(message.endsWith('#494')).toBe(true)
    })
  })
})
