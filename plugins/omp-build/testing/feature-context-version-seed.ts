import { featureFixture } from './feature-recovery-fixture.ts'

// Invoked from a copied current-code fixture with a historical writer version.
process.stdout.write(JSON.stringify(featureFixture('mandate')))
