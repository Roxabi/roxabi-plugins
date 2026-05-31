import { registerResolveFieldIdsSuite } from '../../../../shared/__tests__/resolveFieldIds.suite'

const {
  resolveFieldIds,
  fieldIdForSlot,
  STATUS_FIELD_ID,
  SIZE_FIELD_ID,
  PRIORITY_FIELD_ID,
  STATUS_OPTIONS,
  SIZE_OPTIONS,
  PRIORITY_OPTIONS,
} = await import('../adapters/config-helpers')

registerResolveFieldIdsSuite({
  resolveFieldIds,
  fieldIdForSlot,
  STATUS_FIELD_ID,
  SIZE_FIELD_ID,
  PRIORITY_FIELD_ID,
  STATUS_OPTIONS,
  SIZE_OPTIONS,
  PRIORITY_OPTIONS,
})
