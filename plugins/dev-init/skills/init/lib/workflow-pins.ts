/** SHA-pinned GitHub Actions — fleet consensus (audit 2026-07-02). */
export const ACTION_PINS = {
  checkout: 'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10', // v6
  setupBun: 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6', // v2
  setupNode: 'actions/setup-node@49933ea53b297553b1c3d69c20d3553fa2791a6', // v4
  setupUv: 'astral-sh/setup-uv@5c5fa0c0f1e07b27cd2878e7c576d0b834b4fdb3', // v5
  trufflehog: 'trufflesecurity/trufflehog@47e7b7cd74f578e1e3145d48f669f22fd1330ca6', // v3.94.3
  githubScript: 'actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3', // v9
  semanticPr: 'amannn/action-semantic-pull-request@48f256284bd46cdaab1048c3721360e808335d50', // v6
  createAppToken: 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1', // v3.2.0
} as const
