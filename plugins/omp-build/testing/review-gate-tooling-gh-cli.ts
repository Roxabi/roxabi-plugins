import { toolingGh } from './review-gate-tooling-gh.ts'

const tools = process.argv[2]
if (tools === undefined) throw new Error('Fixture tooling checkout is required')
const result = toolingGh(process.argv.slice(3), tools)
if (result === undefined) throw new Error('Unsupported fixture tooling request')
process.stdout.write(result)
