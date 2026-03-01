/**
 * Create standard dev-core labels on the GitHub repo.
 */

import { STANDARD_LABELS, type LabelDef } from '../../shared/config'
import { run } from '../../shared/github'

export type LabelScope = 'all' | 'type' | 'area' | 'priority'

export async function createLabels(repo: string, scope: LabelScope): Promise<{ created: string[] }> {
  let labels: LabelDef[]
  if (scope === 'all') {
    labels = STANDARD_LABELS
  } else {
    labels = STANDARD_LABELS.filter((l) => l.category === scope)
  }

  const created: string[] = []
  for (const label of labels) {
    try {
      await run(['gh', 'label', 'create', label.name, '--repo', repo, '--description', label.description, '--color', label.color, '--force'])
      created.push(label.name)
    } catch {
      // label creation failed — continue with others
    }
  }

  return { created }
}
