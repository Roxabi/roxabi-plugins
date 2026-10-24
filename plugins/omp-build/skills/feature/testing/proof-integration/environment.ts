import { execFileSync } from 'node:child_process'

export const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
export const ME = 'operator'
export const GAP = 'proof.fx.add-test'
