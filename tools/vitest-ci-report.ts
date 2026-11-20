import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import type { Reporter } from 'vitest/node'

export default class CiReporter implements Reporter {
  onTestRunEnd: NonNullable<Reporter['onTestRunEnd']> = (modules, errors, reason) => {
    const path = process.env.CI_TEST_REPORT
    if (!path) throw new Error('CI_TEST_REPORT must name the report file')
    const results = modules.map((module) => {
      const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 }
      for (const test of module.children.allTests()) counts[test.result().state]++
      const diagnostic = module.diagnostic()
      return {
        file: relative(process.cwd(), module.moduleId).replaceAll('\\', '/'),
        project: module.project.name,
        state: module.state(),
        ...counts,
        duration:
          diagnostic.environmentSetupDuration +
          diagnostic.prepareDuration +
          diagnostic.collectDuration +
          diagnostic.setupDuration +
          diagnostic.duration,
      }
    })
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      `${JSON.stringify({ success: reason === 'passed' && errors.length === 0, modules: results })}\n`,
    )
  }
}
