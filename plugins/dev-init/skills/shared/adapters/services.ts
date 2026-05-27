/**
 * DI factory — wires concrete adapters to their port interfaces.
 * New code should import createServices() rather than instantiating adapters directly.
 * Existing consumers are unaffected.
 */
import type { ConfigPort } from '../ports/config'
import type { IssuePort } from '../ports/issue'
import type { ProjectPort } from '../ports/project'
import { EnvConfigAdapter } from './env-config'
import { GitHubAdapter } from './github-adapter'

export interface Services {
  config: ConfigPort
  issues: IssuePort
  project: ProjectPort
}

export function createServices(): Services {
  const config = new EnvConfigAdapter()
  const github = new GitHubAdapter(config.getRepo(), config.getProjectId())

  return {
    config,
    issues: github,
    project: github,
  }
}
