import { defineConfig } from 'vitest/config'
import rootConfig, { MODEL } from './vitest.config.ts'

// This config is the root for the local model command: shared setup, fixture env,
// and root-once globalSetup come from the actual root config, while only this project runs.
export default defineConfig({
  ...rootConfig,
  test: {
    ...rootConfig.test,
    projects: [
      {
        extends: true,
        test: {
          name: 'phase4-model',
          include: [MODEL],
          testTimeout: 30_000,
        },
      },
    ],
  },
})
