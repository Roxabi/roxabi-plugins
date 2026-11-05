import { createReviewClassCatalogues } from '../dist/contracts.js'
import { fixtureReviewCatalogueReads } from './action-input-fixtures.ts'

/** Construct the table in the bundled engine instance used by installed host consumers. */
export function fixtureHostReviewClassCatalogues() {
  return createReviewClassCatalogues(fixtureReviewCatalogueReads())
}
