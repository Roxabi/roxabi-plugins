/**
 * Dev-core error hierarchy — plugin-specific exceptions replacing generic Error throws.
 */

export class DevCoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DevCoreError'
  }
}

export class GitHubApiError extends DevCoreError {
  readonly statusCode: number | undefined

  constructor(message: string, statusCode?: number) {
    super(message)
    this.name = 'GitHubApiError'
    this.statusCode = statusCode
  }
}

export class ConfigError extends DevCoreError {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export class WorkspaceError extends DevCoreError {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

export class ArtifactError extends DevCoreError {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactError'
  }
}
