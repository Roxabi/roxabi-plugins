import { validatePreparedReviewInput, validateReviewInput } from '../skills/feature/workflow-review-input.js'

const [cwd = '', head = '', raw = '{}'] = process.argv.slice(2)
const snapshot = JSON.parse(raw)
const prepared = await validatePreparedReviewInput(cwd, 7, head, snapshot)
const persisted = await validateReviewInput(cwd, 7, head, snapshot.fingerprint)
console.log(JSON.stringify({ prepared, persisted }))
