import { vi } from 'vitest'
import { registerPriorityLabelsSuite } from '../../../../shared/__tests__/priority-labels.suite'

vi.mock('../adapters/github-adapter', () => ({
  updateLabels: vi.fn(),
}))

const { updateLabels } = await import('../adapters/github-adapter')
const mockUpdateLabels = updateLabels as ReturnType<typeof vi.fn>

const { PRIORITY_LABEL_MAP, PRIORITY_LABELS_SET } = await import('../adapters/config-helpers')
const { syncPriorityLabel } = await import('../adapters/github-infra')

registerPriorityLabelsSuite({
  updateLabels: mockUpdateLabels,
  PRIORITY_LABEL_MAP,
  PRIORITY_LABELS_SET,
  syncPriorityLabel,
})
