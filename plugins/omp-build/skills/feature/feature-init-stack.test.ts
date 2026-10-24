import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { baseFacts } from './feature-init.fixture'
import { applyStack, proposeStack } from './feature-init-stack'
import type { ParseYaml } from './feature-init-types'

let scratch: string | undefined
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})
describe('stack adoption proposal', () => {
  const parse =
    (value: unknown): ParseYaml =>
    () =>
      value

  it('preserves comments while inserting one uniquely located command', () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'omp-init-comment-'))
    const stackPath = path.join(scratch, '.dev', 'stack.yml')
    mkdirSync(path.dirname(stackPath), { recursive: true })
    const stack = '# keep me\ncommands:\n  worktree_setup: tools/setup.sh # existing\n# keep this too\n'
    writeFileSync(stackPath, stack)
    writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    writeFileSync(path.join(scratch, 'package-lock.json'), '{}')

    const proposal = proposeStack(
      scratch,
      { ...baseFacts(), hasWorktree: false, mergeOnGreen: false },
      parse({
        commands: { worktree_setup: 'tools/setup.sh' },
      }),
    )

    expect(proposal.after).toContain('  test: "npm run test"\n# keep this too\n')
    expect(proposal.after).toContain('# keep me')
    expect(proposal.after).not.toContain('\nworktree:')
  })

  it.each([
    ['a flow root', '{ commands: {} }\n', { commands: {} }],
    ['an unreadable document', 'commands:\n  test: [\n', null],
  ])('refuses %s without replacing bytes', (_row, stack, parsed) => {
    scratch = mkdtempSync(path.join(tmpdir(), 'omp-init-refuse-'))
    const stackPath = path.join(scratch, '.dev', 'stack.yml')
    mkdirSync(path.dirname(stackPath), { recursive: true })
    writeFileSync(stackPath, stack)
    const proposal = proposeStack(
      scratch,
      { ...baseFacts(), hasWorktree: false },
      parsed === null
        ? () => {
            throw new Error('bad yaml')
          }
        : parse(parsed),
    )
    applyStack(
      scratch,
      { ...baseFacts(), hasWorktree: false },
      parsed === null
        ? () => {
            throw new Error('bad yaml')
          }
        : parse(parsed),
    )
    expect(proposal.refusal).not.toBeNull()
    expect(readFileSync(stackPath, 'utf8')).toBe(stack)
  })

  it('withholds one commands.test when independent scopes have distinct commands', () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'omp-init-scopes-'))
    mkdirSync(path.join(scratch, '.dev'), { recursive: true })
    writeFileSync(path.join(scratch, '.dev', 'stack.yml'), 'schema_version: "1.0"\n')
    mkdirSync(path.join(scratch, '.github', 'workflows'), { recursive: true })
    writeFileSync(
      path.join(scratch, '.github', 'workflows', 'ci.yml'),
      'jobs:\n  unit:\n    steps:\n      - run: npm test\n  integration:\n    steps:\n      - run: make test\n',
    )
    const proposal = proposeStack(scratch, baseFacts(), parse({ schema_version: '1.0' }))
    expect(proposal.additions.map((addition) => addition.key)).not.toContain('commands.test')
    expect(proposal.conflicts.join('\n')).toContain('independent test commands')
  })

  it('does not turn a non-Node manifest into an invented test command', () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'omp-init-go-'))
    mkdirSync(path.join(scratch, '.dev'), { recursive: true })
    writeFileSync(path.join(scratch, '.dev', 'stack.yml'), 'schema_version: "1.0"\n')
    writeFileSync(path.join(scratch, 'go.mod'), 'module example.test/app\n\ngo 1.24\n')
    const proposal = proposeStack(scratch, baseFacts(), parse({ schema_version: '1.0' }))
    expect(proposal.additions.map((addition) => addition.key)).not.toContain('commands.test')
    expect(proposal.conflicts.join('\n')).toContain('go.mod')
  })
})
