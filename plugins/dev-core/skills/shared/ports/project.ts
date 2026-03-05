/**
 * ProjectPort — role interface for GitHub Project V2 operations.
 */

export interface ProjectPort {
  getItemId(issueNumber: number, overrides?: { projectId?: string; repo?: string }): Promise<string>
  addToProject(nodeId: string, projectId?: string): Promise<string>
  updateField(itemId: string, fieldId: string, optionId: string, projectId?: string): Promise<void>
  addBlockedBy(issueId: string, blockingId: string): Promise<void>
  removeBlockedBy(issueId: string, blockingId: string): Promise<void>
  addSubIssue(parentId: string, childId: string): Promise<void>
  removeSubIssue(parentId: string, childId: string): Promise<void>
  linkProjectToRepo(projectId: string, owner: string, repoName: string): Promise<void>
  getBoardIssueNumbers(owner: string, projectNumber: number): Promise<Set<number>>
}
