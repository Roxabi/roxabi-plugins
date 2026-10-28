import type { Spec } from '../../engine/uw-spec.ts'
import { SPEC_HEADINGS, SPEC_MARKER } from './uw-spec-parser.ts'
import { encodeSpecText, formatItemBody } from './uw-spec-text-codec.ts'

/** Renders explicit payloads so every schema-valid value has one reversible body representation. */
export function renderIssueSpecBody(spec: Spec, metadata?: { complexity?: number }): string {
  const sections: Record<(typeof SPEC_HEADINGS)[number], string> = {
    Origin: encodeSpecText(spec.sections.origin),
    Context: encodeSpecText(spec.sections.context),
    Change: encodeSpecText(spec.sections.change),
    'Acceptance Criteria': spec.criteria
      .map(
        (item) =>
          `- ${item.id} :\n${encodeSpecText(item.statement)
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n')}`,
      )
      .join('\n'),
    Invariants: spec.invariants
      .map(
        (item) =>
          `- ${item.id} :\n${encodeSpecText(item.statement)
            .split('\n')
            .map((line) => `  ${line}`)
            .join('\n')}`,
      )
      .join('\n'),
    Exclusions: spec.exclusions.map((item) => `- ${formatItemBody(encodeSpecText(item))}`).join('\n'),
    'Open Questions': spec.openQuestions.map((item) => `- ${formatItemBody(encodeSpecText(item))}`).join('\n'),
  }
  const rendered = [SPEC_MARKER, ...SPEC_HEADINGS.flatMap((heading) => [`# ${heading}`, sections[heading]])]
  if (metadata?.complexity !== undefined) rendered.push(`<!-- complexity: ${metadata.complexity} -->`)
  return `${rendered.join('\n\n')}\n`
}
