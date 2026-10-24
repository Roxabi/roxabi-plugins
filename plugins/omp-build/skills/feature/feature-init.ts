#!/usr/bin/env bun
import { initFeature } from './feature-init-apply'
import { IssueTriageMissing } from './feature-init-triage'

if (import.meta.main) {
  try {
    await initFeature(process.argv.slice(2))
  } catch (err) {
    const error = err as Error & { exitCode?: number }
    if (err instanceof IssueTriageMissing) {
      console.error(`init=blocked ${error.message}`)
      process.exit(3)
    }
    console.error(error.message)
    process.exit(error.exitCode ?? 1)
  }
}
