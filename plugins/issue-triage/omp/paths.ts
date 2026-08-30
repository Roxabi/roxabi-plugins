/** Dump-time only: expand leftover $CLAUDE_* while registerCommand still injects SKILL.md. */
export function rewriteHarnessPaths(body: string, skillDir: string, pluginRoot: string): string {
  return body
    .replaceAll('${CLAUDE_SKILL_DIR}', skillDir)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
    .replaceAll('$CLAUDE_SKILL_DIR', skillDir)
    .replaceAll('$CLAUDE_PLUGIN_ROOT', pluginRoot)
}
