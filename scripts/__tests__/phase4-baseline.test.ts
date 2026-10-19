import { AssertionError } from 'node:assert'
import { describe, expect, it } from 'vitest'
import { qualifyPhase4Baseline } from './phase4-baseline'

const BLOCKER_CAUSE = '["guard","src/panel/advance.ts:2","or",["ne","approvedAt",null],["ne","status","blocked"]]'
const BLOCKER_WITNESS =
  '["witness",["input","approvedAt",null],["input","status","pending"],["result","src/panel/advance.ts:2",true],["result","src/panel/submit.ts:3","published"]]'
const WARNING_CAUSE = '["mapping","src/panel/status.ts:2","approved","ready","local-literal"]'
const WARNING_WITNESS =
  '["witness",["mapping","src/panel/status.ts:2","approved","ready"],["supplied-safety-path",false]]'
const BLOCKER_PROVENANCE =
  '[{agent: fixture-adversarial, phase: panel, chunk: 1, callsites: [{file: src/panel/advance.ts, line: 2}, {file: src/panel/submit.ts, line: 3}]}]'
const BLOCKER_CALLSITES = '[{file: src/panel/advance.ts, line: 2}, {file: src/panel/submit.ts, line: 3}]'
const WARNING_PROVENANCE =
  '[{agent: fixture-architect, phase: panel, chunk: 1, callsites: [{file: src/panel/status.ts, line: 2}]}]'
const WARNING_CALLSITES = '[{file: src/panel/status.ts, line: 2}]'

type FindingOverride = Partial<
  Record<'cause' | 'witness' | 'provenance' | 'callsites' | 'emitter' | 'citation', string>
>

const blocker = (overrides: FindingOverride = {}) =>
  [
    '### Blockers',
    'issue: A paraphrased explanation of the supplied pending-panel finding',
    `  ${overrides.citation ?? 'src/panel/advance.ts:2'}`,
    `  -- ${overrides.emitter ?? 'fixture-adversarial'}`,
    `  Provenance: ${overrides.provenance ?? BLOCKER_PROVENANCE}`,
    `  Root cause: ${overrides.cause ?? BLOCKER_CAUSE}`,
    `  Symptoms/evidence: ${overrides.witness ?? BLOCKER_WITNESS}`,
    `  Raw callsites: ${overrides.callsites ?? BLOCKER_CALLSITES}`,
    '  Confidence: 96%',
  ].join('\n')

const warning = (overrides: FindingOverride = {}) =>
  [
    '### Warnings',
    'suggestion: A differently worded explanation of the status vocabulary finding',
    `  ${overrides.citation ?? 'src/panel/status.ts:2'}`,
    `  -- ${overrides.emitter ?? 'fixture-architect'}`,
    `  Provenance: ${overrides.provenance ?? WARNING_PROVENANCE}`,
    `  Root cause: ${overrides.cause ?? WARNING_CAUSE}`,
    `  Symptoms/evidence: ${overrides.witness ?? WARNING_WITNESS}`,
    `  Raw callsites: ${overrides.callsites ?? WARNING_CALLSITES}`,
    '  Confidence: 72%',
  ].join('\n')

function rendered(findings = [blocker(), warning()]): string {
  return [
    '<!-- omp-build:code-review -->',
    '## Findings',
    ...findings,
    '## Summary',
    'The unrestricted explanation is not qualified.',
  ].join('\n')
}

function rejectSemantically(body: string): void {
  try {
    qualifyPhase4Baseline(body)
    throw new Error('qualifier accepted an invalid rendered baseline')
  } catch (error) {
    expect(error).toBeInstanceOf(AssertionError)
  }
}

describe('qualifyPhase4Baseline', () => {
  it('accepts the complete two-finding control and harmless presentation variants', () => {
    expect(() => qualifyPhase4Baseline(rendered())).not.toThrow()
    expect(() =>
      qualifyPhase4Baseline(
        rendered([
          warning({
            provenance:
              '[{phase: \'panel\', callsites: [{line: 2, file: "src/panel/status.ts"}], chunk: 1, agent: fixture-architect}]',
            callsites: '[{line: 2, file: src/panel/status.ts}]',
            cause: `\`\`\`json\n${JSON.stringify(JSON.parse(WARNING_CAUSE), null, 2)}\n\`\`\``,
          }),
          blocker({
            provenance:
              '[{callsites: [{line: 3, file: src/panel/submit.ts}, {line: 2, file: src/panel/advance.ts}], chunk: 1, phase: panel, agent: fixture-adversarial}]',
            callsites: '[{line: 3, file: src/panel/submit.ts}, {line: 2, file: src/panel/advance.ts}]',
            witness: `\`\`\`\n${JSON.stringify(JSON.parse(BLOCKER_WITNESS), null, 2)}\n\`\`\``,
          }),
        ]),
      ),
    ).not.toThrow()
  })

  it.each([
    ['Root cause', BLOCKER_CAUSE],
    ['Symptoms/evidence', BLOCKER_WITNESS],
    ['Provenance', BLOCKER_PROVENANCE],
    ['Raw callsites', BLOCKER_CALLSITES],
  ])('rejects field-looking continuations inside the complete %s value', (field, value) => {
    for (const indentation of ['    ', '\t']) {
      rejectSemantically(
        rendered().replace(
          `  ${field}: ${value}`,
          `  ${field}: ${value}\n${indentation}Contradiction: ${WARNING_CAUSE}`,
        ),
      )
    }
  })

  it.each([
    ['Root cause', (body: string) => body.replace(`  Root cause: ${BLOCKER_CAUSE}\n`, '')],
    ['Symptoms/evidence', (body: string) => body.replace(`  Symptoms/evidence: ${BLOCKER_WITNESS}\n`, '')],
    ['Provenance', (body: string) => body.replace(`  Provenance: ${BLOCKER_PROVENANCE}\n`, '')],
    ['Raw callsites', (body: string) => body.replace(`  Raw callsites: ${BLOCKER_CALLSITES}\n`, '')],
    ['citation', (body: string) => body.replace('  src/panel/advance.ts:2\n', '')],
    ['emitter', (body: string) => body.replace('  -- fixture-adversarial\n', '')],
  ])('rejects missing required %s', (_, mutate) => {
    rejectSemantically(mutate(rendered()))
  })

  it.each([
    ['historical negated guard (typed or→and)', BLOCKER_CAUSE.replace('"or"', '"and"')],
    ['historical negated guard result (typed true→false)', BLOCKER_WITNESS.replace(',true]', ',false]')],
    ['historical publication loss (typed published→held)', BLOCKER_WITNESS.replace('"published"', '"held"')],
    ['historical supplied safety path polarity (typed false→true)', WARNING_WITNESS.replace('false', 'true')],
  ])('rejects factual polarity or loss: %s', (_, replacement) => {
    const body = replacement.includes('supplied-safety-path')
      ? rendered([blocker(), warning({ witness: replacement })])
      : replacement.includes('guard')
        ? rendered([blocker({ cause: replacement }), warning()])
        : rendered([blocker({ witness: replacement }), warning()])
    rejectSemantically(body)
  })

  it.each([
    [
      'blocker approval predicate',
      rendered([blocker({ cause: BLOCKER_CAUSE.replace(',["ne","approvedAt",null]', '') }), warning()]),
    ],
    [
      'blocker status predicate',
      rendered([blocker({ cause: BLOCKER_CAUSE.replace(',["ne","status","blocked"]', '') }), warning()]),
    ],
    [
      'blocker approved-at witness',
      rendered([blocker({ witness: BLOCKER_WITNESS.replace(',["input","approvedAt",null]', '') }), warning()]),
    ],
    [
      'blocker status witness',
      rendered([blocker({ witness: BLOCKER_WITNESS.replace(',["input","status","pending"]', '') }), warning()]),
    ],
    [
      'blocker guard-result witness',
      rendered([
        blocker({ witness: BLOCKER_WITNESS.replace(',["result","src/panel/advance.ts:2",true]', '') }),
        warning(),
      ]),
    ],
    [
      'blocker publication witness',
      rendered([
        blocker({ witness: BLOCKER_WITNESS.replace(',["result","src/panel/submit.ts:3","published"]', '') }),
        warning(),
      ]),
    ],
    [
      'warning local-literal cause fact',
      rendered([blocker(), warning({ cause: WARNING_CAUSE.replace(',"local-literal"', '') })]),
    ],
    [
      'warning mapping witness',
      rendered([
        blocker(),
        warning({ witness: WARNING_WITNESS.replace(',["mapping","src/panel/status.ts:2","approved","ready"]', '') }),
      ]),
    ],
    [
      'warning supplied-safety-path witness',
      rendered([blocker(), warning({ witness: WARNING_WITNESS.replace(',["supplied-safety-path",false]', '') })]),
    ],
  ])('rejects loss of each typed carrier fact: %s', (_, body) => {
    rejectSemantically(body)
  })

  it.each([
    ['historical blocker cause replaced by warning cause', rendered([blocker({ cause: WARNING_CAUSE }), warning()])],
    ['historical warning cause replaced by blocker cause', rendered([blocker(), warning({ cause: BLOCKER_CAUSE })])],
    [
      'historical blocker witness replaced by warning witness',
      rendered([blocker({ witness: WARNING_WITNESS }), warning()]),
    ],
    [
      'historical warning witness replaced by blocker witness',
      rendered([blocker(), warning({ witness: BLOCKER_WITNESS })]),
    ],
    [
      'foreign blocker cause fact appended',
      rendered([blocker({ cause: `${BLOCKER_CAUSE.slice(0, -1)},["ne","foreign",null]]` }), warning()]),
    ],
    [
      'foreign warning witness fact appended',
      rendered([blocker(), warning({ witness: `${WARNING_WITNESS.slice(0, -1)},["foreign",true]]` })]),
    ],
  ])('rejects cross-finding substitutions and foreign facts: %s', (_, body) => {
    rejectSemantically(body)
  })

  it.each([
    [
      'historical adjacent duplicate emitter',
      (body: string) =>
        body.replace('  -- fixture-adversarial\n', '  -- fixture-adversarial\n  -- fixture-adversarial\n'),
    ],
    [
      'historical emitter after provenance duplicate (already rejected)',
      (_body: string) =>
        rendered([blocker({ provenance: `${BLOCKER_PROVENANCE}\n  -- fixture-adversarial` }), warning()]),
    ],
    [
      'duplicate citation',
      (body: string) =>
        body.replace('  src/panel/advance.ts:2\n', '  src/panel/advance.ts:2\n  src/panel/advance.ts:2\n'),
    ],
    [
      'duplicate Provenance field',
      (body: string) =>
        body.replace(
          `  Provenance: ${BLOCKER_PROVENANCE}\n`,
          `  Provenance: ${BLOCKER_PROVENANCE}\n  Provenance: ${BLOCKER_PROVENANCE}\n`,
        ),
    ],
    [
      'duplicate Root cause field',
      (body: string) =>
        body.replace(
          `  Root cause: ${BLOCKER_CAUSE}\n`,
          `  Root cause: ${BLOCKER_CAUSE}\n  Root cause: ${BLOCKER_CAUSE}\n`,
        ),
    ],
    [
      'duplicate Symptoms/evidence field',
      (body: string) =>
        body.replace(
          `  Symptoms/evidence: ${BLOCKER_WITNESS}\n`,
          `  Symptoms/evidence: ${BLOCKER_WITNESS}\n  Symptoms/evidence: ${BLOCKER_WITNESS}\n`,
        ),
    ],
    [
      'duplicate Raw callsites field',
      (body: string) =>
        body.replace(
          `  Raw callsites: ${BLOCKER_CALLSITES}\n`,
          `  Raw callsites: ${BLOCKER_CALLSITES}\n  Raw callsites: ${BLOCKER_CALLSITES}\n`,
        ),
    ],
    [
      'duplicate decoded metadata key',
      (body: string) =>
        body.replace(
          'agent: fixture-adversarial, phase:',
          'agent: fixture-adversarial, "agent": fixture-adversarial, phase:',
        ),
    ],
    [
      'duplicate nested metadata key',
      (body: string) =>
        body.replace(
          'file: src/panel/advance.ts, line: 2',
          'file: src/panel/advance.ts, "file": src/panel/advance.ts, line: 2',
        ),
    ],
    [
      'trailing metadata syntax',
      (body: string) =>
        body.replace(`Raw callsites: ${WARNING_CALLSITES}`, `Raw callsites: ${WARNING_CALLSITES} trailing`),
    ],
    ['unsupported metadata syntax', (body: string) => body.replace('phase: panel', 'phase: &panel panel')],
  ])('rejects ambiguity or contradiction: %s', (_, mutate) => {
    rejectSemantically(mutate(rendered()))
  })

  it.each([
    ['a missing finding', rendered([blocker()])],
    ['a duplicate finding', rendered([blocker(), blocker(), warning()])],
    [
      'an additional finding',
      rendered([blocker(), warning(), ['### Suggestions', 'thought: unrelated', '  src/panel/other.ts:1'].join('\n')]),
    ],
    ['merged groups', rendered([blocker().replace('### Blockers', '### Warnings'), warning()])],
    ['wrong label', rendered([blocker().replace('issue:', 'suggestion:'), warning()])],
    ['ungrouped finding', rendered([blocker(), 'issue: ungrouped', warning()])],
    ['outside Findings', `${rendered()}\nissue: outside\n  src/panel/advance.ts:2`],
  ])('rejects incomplete or misgrouped membership: %s', (_, body) => {
    rejectSemantically(body)
  })

  it.each([
    ['wrong emitter association', rendered([blocker({ emitter: 'fixture-architect' }), warning()])],
    ['wrong citation association', rendered([blocker({ citation: 'src/panel/status.ts:2' }), warning()])],
    [
      'wrong provenance association',
      rendered([
        blocker({
          provenance:
            '[{agent: fixture-architect, phase: panel, chunk: 1, callsites: [{file: src/panel/advance.ts, line: 2}, {file: src/panel/submit.ts, line: 3}]}]',
        }),
        warning(),
      ]),
    ],
    ['wrong raw-callsite association', rendered([blocker({ callsites: WARNING_CALLSITES }), warning()])],
  ])('rejects complete association errors: %s', (_, body) => {
    rejectSemantically(body)
  })

  it.each([
    [
      'trailing prose in a factual carrier',
      rendered([blocker({ cause: `${BLOCKER_CAUSE}\n  retained prose` }), warning()]),
    ],
    ['a second factual payload', rendered([blocker({ witness: `${BLOCKER_WITNESS}\n  ["witness"]` }), warning()])],
    ['unsupported old prose carrier', rendered([blocker({ cause: 'The guard looks permissive.' }), warning()])],
  ])('rejects non-whole typed factual values: %s', (_, body) => {
    rejectSemantically(body)
  })
})
