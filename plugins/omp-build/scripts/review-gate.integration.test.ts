import { afterEach } from 'vitest'
import { cleanupReviewGateFixture } from '../testing/review-gate-fixture.ts'
import { registerReviewGateFormatCases } from './review-gate-format.cases.ts'
import { registerReviewGateMandateCases } from './review-gate-mandate.cases.ts'
import { registerReviewGateRefusalCases } from './review-gate-refusal.cases.ts'

afterEach(cleanupReviewGateFixture)

registerReviewGateMandateCases()
registerReviewGateFormatCases()
registerReviewGateRefusalCases()
