import { type OmpBuildExtensionOptions, registerOmpCommandsAndTools } from './omp-commands'
import { type OmpBuildExtensionApi, reviewControllerFor } from './omp-controller'
import { featureWorkInterrupter, installFeatureSessionLifecycle } from './omp-feature-session'
import { installOmpToolGuards } from './omp-tool-guards'

export default function ompBuildExtension(pi: OmpBuildExtensionApi, options: OmpBuildExtensionOptions = {}): void {
  // User-only by construction, on the one lane that exists: `registerCommand` is
  // the slash lane, `registerTool` is the LLM one (omp://extensions.md), and the
  // model cannot reach a command. That alone is the property. A body's
  // `disable-model-invocation` is not a second gate — omp normalises it to `hide`,
  // which omits the skill from the prompt listing while `skill://<name>` and
  // `/skill:<name>` still reach it (measured on omp 18.2.9).
  //
  // No `rewriteHarnessPaths` here: nothing this plugin dumps carries a
  // `${CLAUDE_*}` path token to expand — agent bodies and skill bodies, the
  // surface these commands added, are held to that by
  // `testing/agent-roster.test.ts` ("cites no plugin-root token").
  reviewControllerFor(pi)
  const interruptOwnedFeatureWork = featureWorkInterrupter(pi)
  installFeatureSessionLifecycle(pi, options, interruptOwnedFeatureWork)
  registerOmpCommandsAndTools(pi, options, interruptOwnedFeatureWork)
  installOmpToolGuards(pi)

  // format hook + principal post-nudge: deferred. Never sendUserMessage on tool_result
  // (OMP treats that as a user turn and the agent may git-switch off the feature branch).
}
