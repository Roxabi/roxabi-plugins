/**
 * ArtifactRepository — role interface for frame/analysis/spec/plan file operations.
 */

export interface ArtifactMeta {
  title: string
  issue?: number
  status?: string
  tier?: string
  date?: string
}

export interface ArtifactRepository {
  list(dir: 'frames' | 'analyses' | 'specs' | 'plans'): Promise<string[]>
  read(path: string): Promise<string>
  readMeta(path: string): Promise<ArtifactMeta>
  write(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
}
