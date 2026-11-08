import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Installed issue-triage emit. Paths come from this file only. */
const sliceRoot = fileURLToPath(new URL('./dist/issue-triage', import.meta.url))

export const migrateLabelsFile = join(sliceRoot, 'skills', 'issue-triage', 'lib', 'migrate-labels.ts')
export const initFile = join(sliceRoot, 'skills', 'issue-triage', 'lib', 'init.ts')
