import type { Group, Label } from './record-values.ts'

export function groupFor(label: Label): Group {
  if (label === 'issue' || label === 'issue(blocking)' || label === 'todo' || label === 'suggestion(blocking)')
    return 'Blockers'
  if (label === 'suggestion' || label === 'suggestion(non-blocking)' || label === 'nitpick') return 'Warnings'
  if (label === 'thought' || label === 'question') return 'Suggestions'
  return 'Praise'
}
