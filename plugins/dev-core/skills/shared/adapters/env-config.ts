/**
 * EnvConfigAdapter — concrete ConfigPort backed by process.env.
 */
import type { ProjectFieldIds } from '../domain/types'
import type { ConfigPort } from '../ports/config'
import type { WorkspaceProject } from '../ports/workspace'
import {
  detectGitHubRepo,
  FIELD_MAP,
  GH_PROJECT_ID,
  isProjectConfigured,
  PRIORITY_ALIASES,
  PRIORITY_FIELD_ID,
  PRIORITY_OPTIONS,
  resolveFieldIds,
  resolvePriority,
  resolveSize,
  resolveStatus,
  SIZE_FIELD_ID,
  SIZE_OPTIONS,
  STATUS_ALIASES,
  STATUS_FIELD_ID,
  STATUS_OPTIONS,
} from '../config'

export class EnvConfigAdapter implements ConfigPort {
  getRepo(): string {
    return detectGitHubRepo()
  }

  getProjectId(): string | null {
    return GH_PROJECT_ID || null
  }

  getFieldMap(): Record<string, { fieldId: string; options: Record<string, string> }> {
    return FIELD_MAP
  }

  resolveFieldIds(project: WorkspaceProject): ProjectFieldIds {
    return resolveFieldIds(project as any)
  }

  isProjectConfigured(): boolean {
    return isProjectConfigured()
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
