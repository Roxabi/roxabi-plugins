#!/usr/bin/env bun

const [,, cmd, ...rest] = process.argv

const USAGE = `
roxabi — multi-project GitHub Projects management for Claude Code

Usage:
  roxabi <command> [options]

Commands:
  workspace    Manage workspace configuration and projects
  issues       List, filter, and bulk-update issues across projects
  triage       Interactive triage workflow for incoming issues
  dashboard    Launch the live project dashboard

Version: 0.1.0
`.trim()

switch (cmd) {
  case 'workspace': {
    await import('./commands/workspace').then(m => m.run(rest))
    break
  }

  case 'issues': {
    await import('./commands/issues').then(m => m.run(rest))
    break
  }

  case 'triage': {
    await import('./commands/triage').then(m => m.run(rest))
    break
  }

  case 'dashboard': {
    await import('./commands/dashboard').then(m => m.run(rest))
    break
  }

  case undefined: {
    console.log(USAGE)
    process.exit(0)
  }

  default: {
    console.error(`Unknown command: ${cmd}`)
    console.error(USAGE)
    process.exit(1)
  }
}
