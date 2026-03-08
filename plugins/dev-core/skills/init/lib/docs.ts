/**
 * Docs scaffolding — creates standard documentation directory structure.
 * Generates minimal template files based on project type and docs format.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

export interface DocsScaffoldOpts {
  format: 'md' | 'mdx'
  path: string
}

export interface DocsScaffoldResult {
  docsPath: string
  dirsCreated: string[]
  filesCreated: string[]
  filesSkipped: string[]
}

interface TemplateFile {
  relativePath: string
  content: string
}

function buildTemplates(format: 'md' | 'mdx'): TemplateFile[] {
  const ext = format === 'mdx' ? 'mdx' : 'md'
  return [
    {
      relativePath: `architecture/index.${ext}`,
      content: `# Architecture

Overview of the project architecture, key design decisions, and system boundaries.

## High-Level Overview

TODO: Add architecture diagram or description.

## Key Decisions

See the \`adr/\` directory for Architecture Decision Records.
`,
    },
    {
      relativePath: `architecture/patterns.${ext}`,
      content: `# Patterns

Recurring patterns and conventions used in this project.

## TODO

- Document naming conventions
- Document error handling patterns
- Document data flow patterns
`,
    },
    {
      relativePath: `standards/backend-patterns.${ext}`,
      content: `# Backend Patterns

Conventions and patterns for backend code in this project.

## Module Structure

TODO: Document module/file organization.

## Error Handling

TODO: Document error handling conventions.

## Data Access

TODO: Document data access patterns.
`,
    },
    {
      relativePath: `standards/testing.${ext}`,
      content: `# Testing Standards

Testing conventions and requirements for this project.

## Test Structure

TODO: Document test file organization and naming.

## Coverage Requirements

TODO: Document minimum coverage thresholds.

## Test Patterns

TODO: Document common test patterns (fixtures, mocks, etc.).
`,
    },
    {
      relativePath: `standards/code-review.${ext}`,
      content: `# Code Review Standards

Guidelines for reviewing code in this project.

## Review Checklist

- [ ] Code follows project patterns (see \`backend-patterns\`)
- [ ] Tests added/updated for changes
- [ ] No security vulnerabilities introduced
- [ ] Documentation updated if needed
`,
    },
    {
      relativePath: `contributing.${ext}`,
      content: `# Contributing

How to contribute to this project.

## Getting Started

TODO: Document setup steps.

## Development Workflow

TODO: Document branch strategy, PR process, commit conventions.
`,
    },
  ]
}

export function scaffoldDocs(opts: DocsScaffoldOpts): DocsScaffoldResult {
  const { format, path: docsPath } = opts
  const result: DocsScaffoldResult = {
    docsPath,
    dirsCreated: [],
    filesCreated: [],
    filesSkipped: [],
  }

  const dirs = ['architecture', 'architecture/adr', 'standards', 'guides']

  for (const dir of dirs) {
    const fullDir = `${docsPath}/${dir}`
    if (!existsSync(fullDir)) {
      mkdirSync(fullDir, { recursive: true })
      result.dirsCreated.push(dir)
    }
  }

  const templates = buildTemplates(format)

  for (const tpl of templates) {
    const fullPath = `${docsPath}/${tpl.relativePath}`
    if (existsSync(fullPath)) {
      result.filesSkipped.push(tpl.relativePath)
    } else {
      writeFileSync(fullPath, tpl.content)
      result.filesCreated.push(tpl.relativePath)
    }
  }

  return result
}
