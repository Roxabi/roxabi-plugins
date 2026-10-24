import type { Files } from './sandbox-types'

/** `semctx setup`'s config.json (0.4.2), verbatim: Semctx validates it against its schema. */
export const SEMCTX_CONFIG = `${JSON.stringify(
  {
    include: ['src/**/*.ts'],
    exclude: ['node_modules', 'dist', '.semctx', '.git', 'coverage'],
    docsDirs: ['docs'],
    migrationsDirs: ['migrations'],
    testGlobs: ['**/*.test.ts', '**/*.spec.ts', 'test/**/*.ts'],
    semanticProvider: 'none',
    blockingRules: [
      {
        id: 'invariant-needs-test',
        description: 'A change touching an invariant-constrained symbol must be covered by a test.',
        when: 'invariant_touched_without_test',
        severity: 'block',
        tier: 'strict',
      },
      {
        id: 'critical-contract-needs-test',
        description:
          'A change to a critical exported contract (tagged `critical`/`security`) must be covered by a test.',
        when: 'critical_contract_changed_without_test',
        severity: 'block',
        tier: 'strict',
      },
      {
        id: 'security-needs-verification',
        description: 'A security-surface change needs an explicit verification.',
        when: 'security_surface_without_verification',
        severity: 'block',
        tier: 'strict',
      },
      {
        id: 'contract-needs-test',
        description: 'A change to an exported contract should be covered by a contract test.',
        when: 'contract_changed_without_test',
        severity: 'warn',
        tier: 'advisory',
      },
      {
        id: 'contradiction-unresolved',
        description: 'An unresolved contradiction in touched sources should be surfaced.',
        when: 'contradiction_unresolved',
        severity: 'warn',
        tier: 'advisory',
      },
    ],
    version: 1,
  },
  null,
  2,
)}\n`

export const STACK = ['landing:', '  mode: native', '  required_checks:', '    - ci', ''].join('\n')
/** The same landing, with an e2e command: a ui-manual-only gap is never justified then. */
export const STACK_E2E = `${STACK}commands:\n  test_e2e: bun run e2e\n`

export const ADD = 'export function add(a: number, b: number): number {\n  return a + b\n}\n'
export const FINITE_ADD =
  'export function add(a: number, b: number): number {\n  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new RangeError("finite only")\n  return a + b\n}\n'
export const evidence = (status: string) =>
  `evidence proof.fx.add-test\n  statement: the add test runs\n  status: ${status}\n  link: test:src/a.test.ts\n`
export const contract = (lines: string[]) =>
  ['change change.fx.add', '  statement: Harden add', '  status: active', '  provenance: author', ...lines, ''].join(
    '\n',
  )
export const SERVES = '  serves: goal.fx.add'
export const PRESERVES = '  preserves: invariant.fx.add-sum'
export const REQUIRES = '  requires_evidence: proof.fx.add-test'
export const LINK = '  link: file:src/a.ts'
export const CONTRACT = '.semctx/semantic/changes/change.fx.add.sem'
export const EVIDENCE = '.semctx/semantic/evidence.sem'

export const SEMCTX_BASE: Files = {
  '.gitignore': '.semctx/*\n!.semctx/semantic/\n!.semctx/config.json\n',
  '.dev/stack.yml': STACK,
  '.semctx/config.json': SEMCTX_CONFIG,
  '.semctx/semantic/goals.sem': 'goal goal.fx.add\n  statement: add returns the sum\n',
  '.semctx/semantic/invariants.sem':
    'invariant invariant.fx.add-sum\n  rule: add(a, b) equals a + b\n  serves: goal.fx.add\n  link: sym:function:src/a.ts:add\n',
  [EVIDENCE]: evidence('declared'),
  'src/a.ts': ADD,
  'src/a.test.ts':
    "import { expect, test } from 'bun:test'\nimport { add } from './a'\ntest('add', () => expect(add(1, 2)).toBe(3))\n",
}
