/**
 * Re-exports from shared config — issues skill uses the same constants.
 * Dashboard-specific additions (if any) go below the re-exports.
 */

export {
  FIELD_MAP,
  GITHUB_REPO,
  PRIORITY_OPTIONS,
  PRIORITY_ORDER,
  PRIORITY_SHORT,
  PROJECT_ID,
  SIZE_FIELD_ID,
  SIZE_OPTIONS,
  STATUS_FIELD_ID,
  STATUS_OPTIONS,
  STATUS_SHORT,
} from '../../shared/config'

export { ISSUES_QUERY as QUERY, ITEM_ID_QUERY, UPDATE_FIELD_MUTATION } from '../../shared/queries'
