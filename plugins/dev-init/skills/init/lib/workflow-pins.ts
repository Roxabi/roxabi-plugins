/** SHA-pinned GitHub Actions — fleet consensus (audit 2026-07-02).
 *  Dependabot cannot see these (they are not workflow files), so a wrong SHA rots
 *  silently until a generated CI run dies at "Set up job".
 *  Verify before committing a change here: `bun run verify:pins`. */
export const ACTION_PINS = {
  checkout: 'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10', // v6
  setupBun: 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6', // v2
  setupNode: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020', // v4
  setupUv: 'astral-sh/setup-uv@d4b2f3b6ecc6e67c4457f6d3e41ec42d3d0fcb86', // v5
  trufflehog: 'trufflesecurity/trufflehog@47e7b7cd74f578e1e3145d48f669f22fd1330ca6', // v3.94.3
  githubScript: 'actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3', // v9
  semanticPr: 'amannn/action-semantic-pull-request@48f256284bd46cdaab1048c3721360e808335d50', // v6
  createAppToken: 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1', // v3.2.0
} as const
