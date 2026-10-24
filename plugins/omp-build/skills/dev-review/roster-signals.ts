import type { StackPaths } from './roster-contract'

const TEST_DIR_RE = /(^|\/)(__tests__|tests?)\//
const TEST_EXT_RE = /\.(test|spec)\.[cm]?[jt]sx?$/
const TEST_PY_RE = /(^|\/)test_[^/]+\.py$/
const TEST_SUFFIX_RE = /_test\.(py|go|rs)$/
const FE_EXT_RE = /\.(tsx|jsx|vue|svelte|css|scss)$/
const AXIAL_RE = /^(infrastructure|adapters|domains|stages)\//
const STRUCTURAL_RES = [
  /(^|\/)docs\/(architecture|architectures)(\/|$)/,
  /(^|\/)docs\/(?:[^/]+\/)*architecture\/adr(\/|$)/,
  /(^|\/)\.?dependency-cruiser\.(c?js|mjs|json|ya?ml)$/,
  /(^|\/)(nx|turbo)\.jsonc?$/,
  /(^|\/)pnpm-workspace\.ya?ml$/,
  /(^|\/)(workspace|workspaces)\.ya?ml$/,
]
const INFRA_RES = [
  /(^|\/)scripts\//,
  /(^|\/)\.github\//,
  /(^|\/)lefthook\.ya?ml$/,
  /(^|\/)wrangler\.(toml|jsonc?|json)$/,
  /(^|\/)deploy\//,
  /(^|\/)deploy\.sh$/,
  /(^|\/)(Dockerfile|Containerfile)$/,
  /(^|\/)docker-compose\.ya?ml$/,
  /(^|\/)(makefile|gnumakefile)$/i,
  /(^|\/)Justfile$/,
  /\.tf$/,
  /\.tfvars$/,
  /(^|\/)k8s\//,
  /(^|\/)helm\//,
  /(^|\/)terraform\//,
  /(^|\/)\.gitlab-ci\.ya?ml$/,
  /(^|\/)\.circleci\//,
  /(^|\/)ansible\//,
  /(^|\/)\.buildkite\//,
  /(^|\/)serverless\.ya?ml$/,
  /(^|\/)Taskfile\.ya?ml$/,
  /(^|\/)charts\/(?:.*\/)?values\.ya?ml$/,
  /(^|\/)Vagrantfile$/,
  /(^|\/)Pulumi\.ya?ml$/,
  /(^|\/)\.dockerignore$/,
  /\.bicep$/,
  /(^|\/)skaffold\.ya?ml$/,
]

/** Security path vocabulary — exact token match (¬substring: `author` must not hit `auth`). */
const TOKEN_SET: Record<string, true> = {
  auth: true,
  authn: true,
  authz: true,
  oauth: true,
  oidc: true,
  saml: true,
  sso: true,
  mfa: true,
  otp: true,
  session: true,
  sessions: true,
  jwt: true,
  login: true,
  signin: true,
  signup: true,
  logout: true,
  secret: true,
  secrets: true,
  crypto: true,
  credential: true,
  credentials: true,
  password: true,
  passwd: true,
  cert: true,
  certs: true,
  tls: true,
  ssl: true,
  rbac: true,
  permission: true,
  permissions: true,
  acl: true,
  iam: true,
  hmac: true,
  keystore: true,
  authenticate: true,
  authentication: true,
  authorize: true,
  authorization: true,
  webauthn: true,
  encrypt: true,
  encryption: true,
  decrypt: true,
  cipher: true,
  aes: true,
  rsa: true,
  csrf: true,
  xsrf: true,
  hash: true,
  salt: true,
  bcrypt: true,
  argon: true,
  pkcs: true,
  apikey: true,
  keypair: true,
  privatekey: true,
  publickey: true,
}

/** tokens(path) := split on [^A-Za-z0-9] ∨ camelCase ∨ letter→digit, then lowercase.
 *  path_hit := ∃ t ∈ tokens(path): Object.hasOwn(TOKEN_SET, t)
 *  ¬naked `token`/`tokens` (design-token collision); ¬unanchored stem substring. */
const TOKEN_SPLIT = /[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])/

export function pathHit(delta: string[]): boolean {
  for (const f of delta) {
    const tokens = f
      .split(TOKEN_SPLIT)
      .filter(Boolean)
      .map((t) => t.toLowerCase())
    if (tokens.some((t) => Object.hasOwn(TOKEN_SET, t))) return true
  }
  return false
}

export function testHit(delta: string[]): boolean {
  return delta.some((f) => TEST_DIR_RE.test(f) || TEST_EXT_RE.test(f) || TEST_PY_RE.test(f) || TEST_SUFFIX_RE.test(f))
}

const SOURCE_EXT_RE = /\.(tsx?|jsx?|py|go|rs|vue|svelte)$/

/** A source file that is not itself a test. Docs and config stay out. */
export function sourceHit(delta: string[]): boolean {
  return delta.some((f) => SOURCE_EXT_RE.test(f) && !testHit([f]))
}

export function infraHit(delta: string[]): boolean {
  return delta.some((f) => INFRA_RES.some((re) => re.test(f)))
}

export function axialDeltaHit(delta: string[]): boolean {
  return delta.some((f) => AXIAL_RE.test(f))
}

function prefixCount(delta: string[], prefixes: string[]): number {
  const normalized = prefixes.map((s) => s.replace(/\/+$/, '')).filter(Boolean)
  return delta.filter((f) => normalized.some((p) => f === p || f.startsWith(`${p}/`))).length
}

/** The domain split outlives the domain roles: it is the only evidence that a diff
 *  crosses the configured frontend/backend boundary, which is an `R-architect`
 *  structural signal (§ structureHit). It selects no agent by itself. */
export function domainFileCounts(delta: string[], paths: StackPaths): { frontend: number; backend: number } {
  const frontendPrefixes = [paths.frontendPath, paths.sharedUi].filter(Boolean)
  const frontend = frontendPrefixes.length
    ? prefixCount(delta, frontendPrefixes)
    : delta.filter((f) => FE_EXT_RE.test(f)).length
  return {
    frontend,
    backend: prefixCount(delta, [paths.backendPath]),
  }
}

/** Conservative architecture signals: explicit architecture/workspace files, a
 * shared root, an ADR path, or a diff crossing configured frontend and backend
 * boundaries. Equal frontend and backend roots are not a crossing. Ordinary
 * F-full source changes outside those roots stay cold. */
export function structureHit(delta: string[], paths: StackPaths): boolean {
  if (delta.some((f) => STRUCTURAL_RES.some((re) => re.test(f)))) return true
  if (paths.adrPath && prefixCount(delta, [paths.adrPath]) > 0) return true
  if (paths.sharedRoots?.length && prefixCount(delta, paths.sharedRoots) > 0) return true
  const frontend = paths.frontendPath.replace(/\/+$/, '')
  const backend = paths.backendPath.replace(/\/+$/, '')
  if (frontend && frontend === backend) return false
  const counts = domainFileCounts(delta, paths)
  return counts.frontend > 0 && counts.backend > 0
}
