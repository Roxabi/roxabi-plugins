import { writeFileSync } from 'node:fs'
import { lineageFixture } from './cause-lineage-fixture.ts'

const path = process.argv[2]
if (!path) throw new Error('Expected output path')
writeFileSync(path, JSON.stringify(lineageFixture(16, false)))
