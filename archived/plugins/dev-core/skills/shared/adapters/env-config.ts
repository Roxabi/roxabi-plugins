/**
 * EnvConfigAdapter — concrete ConfigPort backed by process.env.
 */

import type { ConfigPort } from '../ports/config'
import { detectGitHubRepo, resolvePriority, resolveSize, resolveStatus } from './config-helpers'

export class EnvConfigAdapter implements ConfigPort {
  getRepo(): string {
    return detectGitHubRepo()
  }

  resolveStatus(input: string): string | undefined {
    return resolveStatus(input)
  }

  resolvePriority(input: string): string | undefined {
    return resolvePriority(input)
  }

  resolveSize(input: string): string | undefined {
    return resolveSize(input)
  }
}
