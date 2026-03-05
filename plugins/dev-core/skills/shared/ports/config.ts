/**
 * ConfigPort — role interface for configuration access.
 * Replaces direct process.env reads with a validated interface.
 */
import type { ProjectFieldIds } from '../domain/types'
import type { WorkspaceProject } from './workspace'

export interface ConfigPort {
  getRepo(): string
  getProjectId(): string | null
  getFieldMap(): Record<string, { fieldId: string; options: Record<string, string> }>
  resolveFieldIds(project: WorkspaceProject): ProjectFieldIds
  isProjectConfigured(): boolean
  resolveStatus(input: string): string | undefined
  resolvePriority(input: string): string | undefined
  resolveSize(input: string): string | undefined
}
