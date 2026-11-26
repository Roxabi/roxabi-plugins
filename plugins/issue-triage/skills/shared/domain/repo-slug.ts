/** Public GitHub owner/repo: unchanged owner rule, 1–100 allowed name characters, no reserved name. */
export const REPO_SLUG_RE = /^[a-z0-9][a-z0-9-]*\/(?!(?:\.|\.\.|\.git)$)[a-z0-9._-]{1,100}(?![\s\S])/i
