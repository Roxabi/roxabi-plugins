/**
 * ConfigPort — role interface for configuration access.
 * Replaces direct process.env reads with a validated interface.
 */

export interface ConfigPort {
  getRepo(): string
  resolveStatus(input: string): string | undefined
  resolvePriority(input: string): string | undefined
  resolveSize(input: string): string | undefined
}
