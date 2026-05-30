/**
 * Lane classification patterns — single source of truth for digest lane regexes.
 * Consumed by digest-helpers.ts lane() to route issues into columns A / C (B is the default).
 * Override LANE_PATTERNS at call-site to customise lane routing without touching shared logic.
 */

export interface LanePatterns {
  C: RegExp
  A: RegExp
}

export const LANE_PATTERNS: LanePatterns = {
  C: /brand|lora|v23|v24|avatar|pulid/,
  A: /infra|nats|security|ops\(infra|ops\(sec|quadlet|podman|docker|supervisor|\bci\b|provision/,
}
