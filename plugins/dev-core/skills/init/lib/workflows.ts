/**
 * Generate and write GitHub Actions workflow files.
 */

export interface WorkflowOpts {
  stack: 'bun' | 'node'
  test: 'vitest' | 'jest' | 'none'
  deploy: 'vercel' | 'none'
}

export function generateCiYml(opts: WorkflowOpts): string {
  const runtime = opts.stack === 'bun' ? 'oven-sh/setup-bun@v2' : 'actions/setup-node@v4'
  const setupStep = opts.stack === 'bun'
    ? '      - uses: oven-sh/setup-bun@v2\n      - run: bun install'
    : '      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - run: npm ci'

  const lintCmd = opts.stack === 'bun' ? 'bun lint' : 'npm run lint'
  const typecheckCmd = opts.stack === 'bun' ? 'bun typecheck' : 'npx tsc --noEmit'

  let testStep = ''
  if (opts.test !== 'none') {
    const testCmd = opts.stack === 'bun' ? 'bun test' : 'npm test'
    testStep = `\n      - name: Test\n        run: ${testCmd}`
  }

  return `name: CI
on:
  push:
    branches: [main, staging]
  pull_request:
    branches: [main, staging]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setupStep}
      - name: Lint
        run: ${lintCmd}
      - name: Typecheck
        run: ${typecheckCmd}${testStep}
`
}

export function generateDeployYml(opts: WorkflowOpts): string {
  const setupStep = opts.stack === 'bun'
    ? '      - uses: oven-sh/setup-bun@v2\n      - run: bun install'
    : '      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - run: npm ci'

  let deployStep: string
  if (opts.deploy === 'vercel') {
    deployStep = `      - name: Deploy to Vercel
        run: npx vercel deploy --token \${{ secrets.VERCEL_TOKEN }} --\${{ inputs.target == 'production' && '' || 'no-' }}prod
        env:
          VERCEL_ORG_ID: \${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: \${{ secrets.VERCEL_PROJECT_ID }}`
  } else {
    deployStep = `      - name: Deploy
        run: echo "No deploy target configured — update this workflow"`
  }

  return `name: Deploy Preview
on:
  workflow_dispatch:
    inputs:
      target:
        description: 'Deploy target'
        required: true
        default: 'preview'
        type: choice
        options:
          - preview
          - production

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setupStep}
${deployStep}
`
}

export async function writeWorkflows(opts: WorkflowOpts): Promise<string[]> {
  const fs = require('fs')
  const dir = '.github/workflows'
  fs.mkdirSync(dir, { recursive: true })

  const written: string[] = []

  const ciContent = generateCiYml(opts)
  fs.writeFileSync(`${dir}/ci.yml`, ciContent)
  written.push('ci.yml')

  const deployContent = generateDeployYml(opts)
  fs.writeFileSync(`${dir}/deploy-preview.yml`, deployContent)
  written.push('deploy-preview.yml')

  return written
}
