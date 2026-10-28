/**
 * The published issue-triage complexity rubric.
 *
 * This calculation describes an operator-facing estimate only. It never grants
 * authority to write a size label or overrides an explicit operator judgment.
 */
export type ComplexityFactors = {
  files: number
  risk: number
  architecture: number
  unknowns: number
  domains: number
}

export type ComplexityTier = 'S' | 'F-lite' | 'F-full'

export type ComplexityTierResult = {
  score: number
  tier: ComplexityTier
}

const FACTOR_NAMES: readonly (keyof ComplexityFactors)[] = ['files', 'risk', 'architecture', 'unknowns', 'domains']

function assertFactor(name: keyof ComplexityFactors, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new RangeError(`Complexity factor ${name} must be an integer from 1 to 10`)
  }
}

/** Calculate κ and its canonical issue-triage tier from operator-supplied factors. */
export function calculateTier(factors: ComplexityFactors): ComplexityTierResult {
  for (const name of FACTOR_NAMES) assertFactor(name, factors[name])

  const score = Math.round(
    factors.files * 0.2 +
      factors.risk * 0.25 +
      factors.architecture * 0.25 +
      factors.unknowns * 0.15 +
      factors.domains * 0.15,
  )

  if (score <= 3) return { score, tier: 'S' }
  if (score <= 6) return { score, tier: 'F-lite' }
  return { score, tier: 'F-full' }
}
