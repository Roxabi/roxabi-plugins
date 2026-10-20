import { AssertionError } from 'node:assert'
import { describe, expect, it } from 'vitest'
import { reviewRecords } from '../../plugins/omp-build/skills/feature/workflow.js'
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

const CONSERVED_NATIVE_BODY = `<!-- omp-build:code-review -->
## Code Review

## Spec
no spec available — spec axis not evaluated

## Standards (judgement pass — 12 smells walked, 0 fired)
smells: RAS

## Root causes

### RC-1 — the publication guard treats a non-blocked status as approval
- mechanism: the OR condition accepts either an approval timestamp or any status other than blocked, so pending panels without approval pass the publication gate.
- fix: require both an approval timestamp and a non-blocked status in \`mayAdvance\`, retaining \`submit\` as the consumer of that decision.
- failure: a panel with \`approvedAt=null\` and \`status=pending\` passes \`mayAdvance\` and \`submit\` returns \`published\`.
- restored: pending panels without approval remain held; blocked panels remain held even with an approval timestamp; approved, non-blocked panels can publish.
- paths: \`src/panel/advance.ts:2\` (guard producer) ; \`src/panel/submit.ts:3\` (publication consumer).
- proof: execute the actual \`mayAdvance\` and \`submit\` functions with an unapproved pending panel, an approved blocked panel, and an approved non-blocked panel; assert the respective guard decisions are false, false, and true and submission results are held, held, and published. The pending-panel case fails under the supplied OR condition and passes after the correction. This is a proposed proof, not an executed result.
- findings: \`src/panel/advance.ts:2\` — Pending panels can publish through the changed advance guard

## Findings

### Blockers

issue: Pending panels can publish through the changed advance guard
  src/panel/advance.ts:2
  -- fixture-adversarial
  Provenance: [{agent: fixture-adversarial, phase: panel, chunk: 1, callsites: [{file: src/panel/advance.ts, line: 2}, {file: src/panel/submit.ts, line: 3}]}]
  Root cause: ["guard","src/panel/advance.ts:2","or",["ne","approvedAt",null],["ne","status","blocked"]]
  Symptoms/evidence: ["witness",["input","approvedAt",null],["input","status","pending"],["result","src/panel/advance.ts:2",true],["result","src/panel/submit.ts:3","published"]]
  Raw callsites: [{file: src/panel/advance.ts, line: 2}, {file: src/panel/submit.ts, line: 3}]
  Confidence: 96%

### Warnings

suggestion: The changed status formatter keeps the legacy ready spelling inline
  src/panel/status.ts:2
  -- fixture-architect
  Provenance: [{agent: fixture-architect, phase: panel, chunk: 1, callsites: [{file: src/panel/status.ts, line: 2}]}]
  Root cause: ["mapping","src/panel/status.ts:2","approved","ready","local-literal"]
  Symptoms/evidence: ["witness",["mapping","src/panel/status.ts:2","approved","ready"],["supplied-safety-path",false]]
  Raw callsites: [{file: src/panel/status.ts, line: 2}]
  Confidence: 72%

## Summary

2 findings retained: 1 blocker and 1 warning. No reports were merged; the guard failure and local status mapping are distinct mechanisms. Neither finding concerns a missing or weak test, so neither receives a test-gap label rewrite.

One root cause is planned. The status-formatter warning remains uncited: the supplied context establishes neither a consumer contract nor a safe replacement for the local mapping, so no correction and admissible proof can be planned for it.

**Verdict: Request changes** — 1 blocking finding.`

const ORDINARY_INLINE_PLAN_BULLET = '- mechanism: retain `mayAdvance` as ordinary plan prose'

type FindingOverride = Partial<
  Record<'cause' | 'witness' | 'provenance' | 'callsites' | 'emitter' | 'citation' | 'header', string>
>

const blocker = ({ header = 'issue:', ...overrides }: FindingOverride = {}) =>
  [
    '### Blockers',
    `${header} A paraphrased explanation of the supplied pending-panel finding`,
    `  ${overrides.citation ?? 'src/panel/advance.ts:2'}`,
    `  -- ${overrides.emitter ?? 'fixture-adversarial'}`,
    `  Provenance: ${overrides.provenance ?? BLOCKER_PROVENANCE}`,
    `  Root cause: ${overrides.cause ?? BLOCKER_CAUSE}`,
    `  Symptoms/evidence: ${overrides.witness ?? BLOCKER_WITNESS}`,
    `  Raw callsites: ${overrides.callsites ?? BLOCKER_CALLSITES}`,
    '  Confidence: 96%',
  ].join('\n')

const warning = ({ header = 'suggestion:', ...overrides }: FindingOverride = {}) =>
  [
    '### Warnings',
    `${header} A differently worded explanation of the status vocabulary finding`,
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
    '**Verdict: Request changes**',
  ].join('\n')
}

function expectDeclaredRequestChanges(body: string): void {
  expect(reviewRecords([{ body, author: { login: 'fixture' } }], { me: 'fixture' })).toMatchObject({
    reviews: 1,
    verdict: 'Request changes',
  })
}

function accepts(body: string): void {
  qualifyPhase4Baseline(body)
  expectDeclaredRequestChanges(body)
}

function rejects(body: string): void {
  let thrown: unknown
  try {
    qualifyPhase4Baseline(body)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(AssertionError)
  expectDeclaredRequestChanges(body)
}

function rejectsUnsupportedPresentation(body: string): void {
  let thrown: unknown
  try {
    qualifyPhase4Baseline(body)
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(AssertionError)
  expect((thrown as Error).message).toMatch(/(?:line\s+\d+|:\d+(?::\d+)?)/i)
  expectDeclaredRequestChanges(body)
}

function indentedRecord(record: string): string {
  const [group, ...lines] = record.split('\n')
  return [group, ...lines.map((line) => `    ${line}`)].join('\n')
}

describe('qualifyPhase4Baseline', () => {
  it('accepts the complete two-finding control, reversed groups, and complete pretty factual values', () => {
    for (const body of [
      rendered(),
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
    ]) {
      accepts(body)
    }
  })

  it.each([
    ['plain headers', rendered()],
    ['dash bullet headers', rendered([blocker({ header: '- issue:' }), warning({ header: '- suggestion:' })])],
    ['asterisk bullet headers', rendered([blocker({ header: '* issue:' }), warning({ header: '* suggestion:' })])],
  ])('accepts column-zero %s with two-space record fields', (_, body) => {
    accepts(body)
  })

  it.each([
    [
      'the complete Findings section',
      rendered().replace('## Findings', '<!--\n## Findings').replace('## Summary', '-->\n## Summary'),
    ],
    ['a group heading', rendered().replace('### Blockers', '<!--\n### Blockers\n-->')],
    ['an individual record', rendered([`${blocker().replace('\nissue:', '\n<!--\nissue:')}\n-->`, warning()])],
    ['an unclosed comment', rendered().replace('## Findings', '<!--\n## Findings')],
    [
      'a comment after an escaped backtick',
      rendered().replace('## Findings', 'Literal: \\` <!--\n## Findings').replace('## Summary', '-->\n## Summary'),
    ],
    [
      'a comment after paired backslashes',
      rendered().replace('## Findings', 'Literal: \\\\<!--\n## Findings').replace('## Summary', '-->\n## Summary'),
    ],
  ])('rejects structural membership hidden by HTML comments: %s', (_, body) => {
    rejects(body)
  })

  it.each([
    ['Provenance', BLOCKER_PROVENANCE],
    ['Root cause', BLOCKER_CAUSE],
    ['Symptoms/evidence', BLOCKER_WITNESS],
    ['Raw callsites', BLOCKER_CALLSITES],
    ['citation', 'src/panel/advance.ts:2'],
    ['emitter', '-- fixture-adversarial'],
  ])('rejects a %s identity inside a mixed-line HTML comment', (field, value) => {
    const line = field === 'citation' || field === 'emitter' ? `  ${value}` : `  ${field}: ${value}`
    rejects(rendered().replace(line, `  Note: <!--\n${line}\n  Context: -->`))
  })

  it.each([
    ['same-line inline code', 'The literal is `<!--`.\n'],
    ['longer inline delimiters', 'The literal is `` ` <!-- ``.\n'],
    ['ordinary same-paragraph multiline inline code', 'The literal is `first\nmiddle\nlast`.\n'],
    ['same-paragraph multiline long inline code', 'The literal is ``first\nmiddle\nlast``.\n'],
    ['escaped text', 'The literal is \\<!--.\n'],
    ['backtick-fenced code', '```markdown\n<!--\n```\n'],
    ['tilde-fenced code', '~~~markdown\n<!--\n~~~\n'],
    ['a fence inside a comment', '<!--\n```markdown\n-->\n'],
  ])('preserves approved literal comment examples and code/comment precedence: %s', (_, prefix) => {
    accepts(rendered().replace('## Findings', `${prefix}## Findings`))
  })

  it('explicitly narrows the predecessor multiline inline comment continuation at old line 131', () => {
    rejectsUnsupportedPresentation(
      rendered().replace('## Findings', 'The literal is `first\n<!--\nlast`.\n## Findings'),
    )
  })

  it('keeps commented and fenced examples outside the actual finding set inert', () => {
    accepts(`${rendered()}\n<!--\n## Findings\n### Blockers\nissue: hidden example\n-->`)
    for (const fence of ['```', '~~~', '````', '~~~~']) {
      accepts(`${rendered()}\n${fence}markdown\n## Findings\n### Blockers\nissue: quoted example\n${fence}`)
    }
  })

  it('keeps literal field examples inside inline code out of structural membership', () => {
    const line = `  Root cause: ${BLOCKER_CAUSE}`
    rejects(rendered().replace(line, `  Note: \`<!--\n${line}\n  Context: -->\``))
  })

  it.each(['```', '~~~', '````', '~~~~'])('rejects %s-fenced examples as actual findings or facts', (fence) => {
    rejects(
      rendered().replace('## Findings', `${fence}markdown\n## Findings`).replace('## Summary', `${fence}\n## Summary`),
    )
    rejects(
      rendered([
        `${blocker().replace('### Blockers\n', `### Blockers\n${fence}markdown\n`)}\n${fence}`,
        `${warning().replace('### Warnings\n', `### Warnings\n${fence}markdown\n`)}\n${fence}`,
      ]),
    )
    rejects(
      rendered([
        `${blocker().replace(`  Root cause: ${BLOCKER_CAUSE}`, `${fence}markdown\n  Root cause: ${BLOCKER_CAUSE}`)}\n${fence}`,
        warning(),
      ]),
    )
  })

  it.each([
    ['Root cause', BLOCKER_CAUSE],
    ['Symptoms/evidence', BLOCKER_WITNESS],
    ['Provenance', BLOCKER_PROVENANCE],
    ['Raw callsites', BLOCKER_CALLSITES],
  ])('rejects field-looking continuations inside the complete %s value', (field, value) => {
    for (const indentation of ['    ', '\t']) {
      rejects(
        rendered().replace(
          `  ${field}: ${value}`,
          `  ${field}: ${value}\n${indentation}Contradiction: ${WARNING_CAUSE}`,
        ),
      )
    }
  })

  it.each([
    ['Root cause', BLOCKER_CAUSE],
    ['Symptoms/evidence', BLOCKER_WITNESS],
    ['Provenance', BLOCKER_PROVENANCE],
    ['Raw callsites', BLOCKER_CALLSITES],
  ])('accepts complete %s values below their active header with supported indentation', (field, value) => {
    for (const padding of ['', ' ']) {
      accepts(rendered().replace(`  ${field}: ${value}`, `  ${field}:${padding}\n    ${value}`))
    }
  })

  it('accepts supported pretty and fenced JSON data owned by active factual headers', () => {
    accepts(
      rendered([
        blocker({
          cause: `\`\`\`json\n${JSON.stringify(JSON.parse(BLOCKER_CAUSE), null, 2)}\n\`\`\``,
          witness: JSON.stringify(JSON.parse(BLOCKER_WITNESS), null, 2),
        }),
        warning({
          cause: JSON.stringify(JSON.parse(WARNING_CAUSE), null, 2),
          witness: `\`\`\`\n${JSON.stringify(JSON.parse(WARNING_WITNESS), null, 2)}\n\`\`\``,
        }),
      ]),
    )
  })

  it.each([
    ['Root cause', (body: string) => body.replace(`  Root cause: ${BLOCKER_CAUSE}\n`, '')],
    ['Symptoms/evidence', (body: string) => body.replace(`  Symptoms/evidence: ${BLOCKER_WITNESS}\n`, '')],
    ['Provenance', (body: string) => body.replace(`  Provenance: ${BLOCKER_PROVENANCE}\n`, '')],
    ['Raw callsites', (body: string) => body.replace(`  Raw callsites: ${BLOCKER_CALLSITES}\n`, '')],
    ['citation', (body: string) => body.replace('  src/panel/advance.ts:2\n', '')],
    ['emitter', (body: string) => body.replace('  -- fixture-adversarial\n', '')],
  ])('rejects missing required %s', (_, mutate) => {
    rejects(mutate(rendered()))
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
    rejects(body)
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
    rejects(body)
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
    rejects(body)
  })

  it.each([
    [
      'tuple reordering',
      rendered([
        blocker({
          cause: '["guard","src/panel/advance.ts:2","or",["ne","status","blocked"],["ne","approvedAt",null]]',
        }),
        warning(),
      ]),
    ],
    [
      'tuple duplication',
      rendered([blocker({ cause: `${BLOCKER_CAUSE.slice(0, -1)},["ne","status","blocked"]]` }), warning()]),
    ],
  ])('rejects typed tuple order and multiplicity changes: %s', (_, body) => {
    rejects(body)
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
    rejects(mutate(rendered()))
  })

  it.each([
    ['a missing metadata key', (body: string) => body.replace('phase: panel, ', '')],
    ['a foreign metadata key', (body: string) => body.replace('phase: panel, ', 'scope: panel, ')],
    ['an agent scalar with the wrong type', (body: string) => body.replace('agent: fixture-adversarial', 'agent: 1')],
    ['a chunk scalar with the wrong type', (body: string) => body.replace('chunk: 1', 'chunk: true')],
    ['a callsite line scalar with the wrong type', (body: string) => body.replace('line: 2', 'line: two')],
  ])('rejects exact metadata keys and scalar types: %s', (_, mutate) => {
    rejects(mutate(rendered()))
  })

  it.each([
    [
      'a missing raw callsite',
      (body: string) =>
        body.replace(
          `  Raw callsites: ${BLOCKER_CALLSITES}`,
          '  Raw callsites: [{file: src/panel/advance.ts, line: 2}]',
        ),
    ],
    [
      'a duplicate raw callsite',
      (body: string) =>
        body.replace(
          `  Raw callsites: ${BLOCKER_CALLSITES}`,
          '  Raw callsites: [{file: src/panel/advance.ts, line: 2}, {file: src/panel/submit.ts, line: 3}, {file: src/panel/advance.ts, line: 2}]',
        ),
    ],
    [
      'a foreign raw callsite',
      (body: string) =>
        body.replace(
          `  Raw callsites: ${BLOCKER_CALLSITES}`,
          '  Raw callsites: [{file: src/panel/advance.ts, line: 2}, {file: src/panel/foreign.ts, line: 3}]',
        ),
    ],
    [
      'a missing provenance callsite',
      (body: string) =>
        body.replace(
          `  Provenance: ${BLOCKER_PROVENANCE}`,
          '  Provenance: [{agent: fixture-adversarial, phase: panel, chunk: 1, callsites: [{file: src/panel/advance.ts, line: 2}]}]',
        ),
    ],
  ])('rejects missing, duplicate, and foreign exact callsite associations: %s', (_, mutate) => {
    rejects(mutate(rendered()))
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
    rejects(body)
  })

  it.each([
    'issue:',
    'issue(scope):',
    'suggestion:',
    'suggestion(scope):',
    'todo:',
    'todo(scope):',
    'nitpick:',
    'nitpick(style):',
    'thought:',
    'thought(scope):',
    'question:',
    'question(scope):',
    'praise:',
    'praise(scope):',
  ])('rejects every Conventional Comment label or modifier outside Findings: %s', (label) => {
    rejects(`${rendered()}\n${label} outside`)
  })

  it.each([
    'issue:',
    'issue(scope):',
    'suggestion:',
    'suggestion(scope):',
    'todo:',
    'todo(scope):',
    'nitpick:',
    'nitpick(style):',
    'thought:',
    'thought(scope):',
    'question:',
    'question(scope):',
    'praise:',
    'praise(scope):',
  ])('rejects every Conventional Comment label or modifier ungrouped in Findings: %s', (label) => {
    rejects(rendered().replace('### Blockers', `${label} ungrouped\n### Blockers`))
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
    rejects(body)
  })

  it.each([
    [
      'trailing prose in a factual carrier',
      rendered([blocker({ cause: `${BLOCKER_CAUSE}\n  retained prose` }), warning()]),
    ],
    ['a second factual payload', rendered([blocker({ witness: `${BLOCKER_WITNESS}\n  ["witness"]` }), warning()])],
    ['unsupported old prose carrier', rendered([blocker({ cause: 'The guard looks permissive.' }), warning()])],
  ])('rejects non-whole typed factual values: %s', (_, body) => {
    rejects(body)
  })

  it.each([
    ['indented blocker record header', rendered([blocker().replace('\nissue:', '\n    issue:'), warning()])],
    ['all record lines indented as literal blocks', rendered([indentedRecord(blocker()), indentedRecord(warning())])],
    [
      'Findings wrapped in a raw HTML pre element',
      rendered().replace('## Findings', '<pre>\n## Findings').replace('## Summary', '</pre>\n## Summary'),
    ],
    [
      'the final-review paragraph/list suffix',
      `${rendered()}\nNote: \`\n- issue: Additional finding outside Findings\n  Context: \``,
    ],
  ])('rejects the retained wrong-acceptance regression: %s', (_, body) => {
    rejects(body)
  })

  it('pairs the real list suffix negative with a genuine same-paragraph multiline inline-code positive', () => {
    accepts(rendered().replace('## Findings', 'Literal: `first\nmiddle\nlast` remains in one paragraph.\n## Findings'))
    rejects(`${rendered()}\nNote: \`\n- issue: Additional finding outside Findings\n  Context: \``)
  })

  it.each([
    [
      'a structural tab in an active field',
      rendered().replace(`  Root cause: ${BLOCKER_CAUSE}`, `\tRoot cause: ${BLOCKER_CAUSE}`),
    ],
    ['a raw HTML element in active presentation', rendered().replace('## Findings', '<div>\n## Findings')],
    ['a blockquote container in active presentation', rendered().replace('### Blockers', '> ### Blockers')],
    ['a decorated active identity', rendered().replace('issue:', '**issue**:')],
  ])('rejects unsupported active presentation with an AssertionError location: %s', (_, body) => {
    rejectsUnsupportedPresentation(body)
  })

  it('qualifies the full conserved native body through the ordinary qualifier and unchanged consumer', () => {
    accepts(CONSERVED_NATIVE_BODY)
  })

  it('accepts ordinary inline plan bullets only inside active Root causes through level-three headings', () => {
    accepts(
      rendered().replace(
        '## Findings',
        `## Root causes
### RC-1
${ORDINARY_INLINE_PLAN_BULLET}
### RC-2
${ORDINARY_INLINE_PLAN_BULLET}
## Findings`,
      ),
    )
  })

  it('does not grant Root-causes plan-bullet permission from a closed comment title suffix', () => {
    rejectsUnsupportedPresentation(
      rendered().replace(
        '## Findings',
        `## Root causes <!-- closed comment suffix -->
${ORDINARY_INLINE_PLAN_BULLET}
## Findings`,
      ),
    )
  })

  it('does not grant Root-causes plan-bullet permission from an inline title suffix', () => {
    rejectsUnsupportedPresentation(
      rendered().replace(
        '## Findings',
        `## Root causes \`extra\`
${ORDINARY_INLINE_PLAN_BULLET}
## Findings`,
      ),
    )
  })

  it('rejects the sole-defect ordinary bullet outside Root causes with a located contextual error', () => {
    rejectsUnsupportedPresentation(
      rendered().replace(
        'The unrestricted explanation is not qualified.',
        `${ORDINARY_INLINE_PLAN_BULLET}
The unrestricted explanation is not qualified.`,
      ),
    )
  })

  it.each([
    ['a level-two Summary heading with an inline suffix', '## Summary `Root causes closes here`'],
    ['a level-one Appendix heading with an inline suffix', '# Appendix `Root causes closes here`'],
    ['a level-two Summary heading with a closed comment suffix', '## Summary <!-- Root causes closes here -->'],
    ['a level-two heading whose title is wholly inline', '## `Other`'],
  ])('expires Root-causes plan-bullet permission at %s', (_, terminator) => {
    rejectsUnsupportedPresentation(
      rendered().replace(
        '## Findings',
        `## Root causes
${ORDINARY_INLINE_PLAN_BULLET}
${terminator}
${ORDINARY_INLINE_PLAN_BULLET}
## Findings`,
      ),
    )
  })

  it.each([
    ['a decorated Findings role', '## Findings', '## **Findings**'],
    ['a mixed Findings role', '## Findings', '## Findings `details`'],
    ['a decorated Blockers group role', '### Blockers', '### **Blockers**'],
    ['a mixed Blockers group role', '### Blockers', '### Blockers `details`'],
  ])('does not normalize %s into an exact structural identity', (_, original, decorated) => {
    rejects(rendered().replace(original, decorated))
  })

  it.each([
    [
      'a fenced Root causes heading',
      `\`\`\`markdown
## Root causes
\`\`\`
${ORDINARY_INLINE_PLAN_BULLET}`,
    ],
    [
      'a commented Root causes heading',
      `<!--
## Root causes
-->
${ORDINARY_INLINE_PLAN_BULLET}`,
    ],
  ])('does not let %s grant plan-bullet permission', (_, prefix) => {
    rejectsUnsupportedPresentation(
      rendered().replace(
        '## Findings',
        `${prefix}
## Findings`,
      ),
    )
  })

  it.each([
    [
      'a fenced heading',
      `\`\`\`markdown
## Summary
\`\`\``,
    ],
    [
      'a commented heading',
      `<!--
## Summary
-->`,
    ],
  ])('does not let %s expire active Root-causes plan-bullet permission', (_, inertHeading) => {
    accepts(
      rendered().replace(
        '## Findings',
        `## Root causes
${ORDINARY_INLINE_PLAN_BULLET}
${inertHeading}
${ORDINARY_INLINE_PLAN_BULLET}
## Findings`,
      ),
    )
  })

  it.each([
    'issue:',
    'issue(scope):',
    'suggestion:',
    'suggestion(scope):',
    'todo:',
    'todo(scope):',
    'nitpick:',
    'nitpick(style):',
    'thought:',
    'thought(scope):',
    'question:',
    'question(scope):',
    'praise:',
    'praise(scope):',
  ])('rejects supported Conventional Comment identities inside Root causes: %s', (label) => {
    for (const suffix of ['', ' `closed inline suffix`', ' <!-- closed comment suffix -->']) {
      rejects(
        rendered().replace(
          '## Findings',
          `## Root causes
### RC-1
- ${label} outside Findings${suffix}
## Findings`,
        ),
      )
    }
  })

  it('continues active structural processing from a closing inline span into a comment opener', () => {
    rejects(
      rendered()
        .replace('## Findings', 'Literal: `closed inline span` <!--\n## Findings')
        .replace('## Summary', '-->\n## Summary'),
    )
  })

  it('retains active peer prefixes while decoding their complete invalid inline or comment suffix value', () => {
    for (const suffix of [' `non-JSON annotation`', ' <!-- non-JSON annotation -->']) {
      rejects(rendered().replace(`  Root cause: ${BLOCKER_CAUSE}`, `  Root cause: ${BLOCKER_CAUSE}${suffix}`))
    }
  })

  it.each([
    [
      'a missing blocker record',
      rendered(['### Blockers', warning()]).replace(
        '## Findings',
        `## Root causes
- mechanism: the missing blocker record is described only as ordinary plan prose
## Findings`,
      ),
    ],
    [
      'a missing blocker Root cause field',
      rendered()
        .replace(`  Root cause: ${BLOCKER_CAUSE}\n`, '')
        .replace(
          '## Findings',
          `## Root causes
- mechanism: Root cause: ${BLOCKER_CAUSE} appears only in ordinary plan prose
## Findings`,
        ),
    ],
  ])('rejects %s despite non-CC Root-causes prose and otherwise valid finding groups', (_, body) => {
    rejects(body)
  })
})
