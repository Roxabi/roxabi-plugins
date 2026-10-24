import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRosterConfig } from '../roster-config'
import { hasAxialAdr } from '../roster-files'
import { infraHit, pathHit } from '../roster-signals'
import {
  type AgentOverride,
  defaultConfig,
  dir,
  gate,
  ROSTER,
  RUNNING_AS_ROOT,
  roster,
  useRosterWorkspace,
} from './roster.fixture'

useRosterWorkspace()

describe('pathHit', () => {
  // Authored from the requirement (exact TOKEN_SET membership), not the tokenizer.
  const mustHitNew = [
    'src/authService/index.ts',
    'src/api/v2/AuthController.ts',
    'src/jwtVerify.ts',
    'src/authGuard.ts',
    'src/SessionManager.ts',
    'src/oauth2/client.ts',
    'src/saml2/sp.ts',
    'apps/api/src/middleware/authenticate.ts',
    'src/webauthn/register.ts',
    'src/encryption/aes.ts',
    'src/AUTHZ/policy.ts',
    'src/oAuth2/cb.ts',
  ]
  const mustHitRegression = [
    'src/oauth/provider.ts',
    'src/session/token.ts',
    'src/jwt/sign.ts',
    'src/login/password.ts',
    'api/rbac.ts',
    'src/auth/x.ts',
    'infra/tls-cert.ts',
    'x/authz.ts',
  ]
  const mustNotHit = [
    'src/author.ts',
    'docs/AUTHORS.md',
    'src/authoring/page.tsx',
    'lib/tokenizer.ts',
    'test/latest.ts',
    'src/designer.ts',
    'src/constructor/x.ts',
    'lib/valueOf.ts',
    'a/toString.ts',
    'x/hasOwnProperty.ts',
    'y/__proto__/z.ts',
    'src/tokenService.ts',
    'lib/mysecretstuff.ts',
    'brand/tokens.css',
    'brand/design-tokens.json',
    'docs/secretariat.md',
    'src/credentialing/board.ts',
    'src/cryptocurrency/price.ts',
  ]

  it('must-hit-new: case/digit split + new tokens', () => {
    for (const p of mustHitNew) {
      expect(pathHit([p]), p).toBe(true)
    }
  })

  it('must-hit-regression: separator-token hits still fire', () => {
    for (const p of mustHitRegression) {
      expect(pathHit([p]), p).toBe(true)
    }
  })

  it('packages/crypto-prices/index.ts hits via crypto token — accepted over-match', () => {
    expect(pathHit(['packages/crypto-prices/index.ts'])).toBe(true)
  })

  it('must-not-hit: substring, prototype keys, naked token, unanchored stem stay cold', () => {
    for (const p of mustNotHit) {
      expect(pathHit([p]), p).toBe(false)
    }
  })

  it('brand/tokens.css does not spawn security-auditor', () => {
    const css = roster({ delta: ['brand/tokens.css'] })
    expect(css.path_hit).toBe(false)
    expect(css.spawn_security_auditor).toBe(false)
    const auth = roster({ delta: ['apps/app/src/auth/login.ts'] })
    expect(auth.path_hit).toBe(true)
    expect(auth.spawn_security_auditor).toBe(true)
  })
})

describe('prototype keys are not table members', () => {
  it('a bogus agent named after an Object.prototype key warns and is ignored', () => {
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const cfg = parseRosterConfig(`review:\n  roster:\n    agents:\n      ${key}: always\n`)
      expect(cfg.warnings).toContain(`unknown roster agent: ${key}`)
      expect(cfg.overrides[key]).toBeUndefined()
    }
  })

  it('a bogus override value named after an Object.prototype key warns and is ignored', () => {
    const cfg = parseRosterConfig('review:\n  roster:\n    agents:\n      R-tester: constructor\n')
    expect(cfg.warnings.join(' ')).toMatch(/invalid override for R-tester/)
    expect(cfg.overrides['R-tester']).toBeUndefined()
  })

  it('parseRosterConfig returns a null-prototype overrides table', () => {
    const cfg = parseRosterConfig('review:\n  roster:\n    agents:\n      R-tester: always\n')
    expect(Object.getPrototypeOf(cfg.overrides)).toBeNull()
  })

  // The safety must live in applyOverride, not in how a caller happened to build the config:
  // an inherited `never` must never suppress a gate that fired.
  it('inherited override properties are ignored by applyOverride', () => {
    const overrides: Record<string, AgentOverride> = Object.create({ 'R-architect': 'never' })
    const out = roster({
      delta: ['docs/architecture/model.md'],
      tier: 'F-full',
      config: defaultConfig({ overrides }),
    })
    expect(out.agents).toContain('R-architect')
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: true, reason: 'structure' })
  })
})

describe('infraHit', () => {
  // Requirement: CI/CD, containers, IaC, deploy, host/config-as-code. ¬app source, docs, manifests.
  const mustHit = [
    'scripts/x.sh',
    'apps/web/scripts/build.sh',
    '.github/workflows/ci.yml',
    'lefthook.yml',
    'wrangler.toml',
    'deploy/hook.sh',
    'deploy.sh',
    'Dockerfile',
    'docker-compose.yml',
    'Makefile',
    'Justfile',
    'main.tf',
    'k8s/deploy.yml',
    'helm/Chart.yaml',
    'terraform/main.tf',
    '.gitlab-ci.yml',
    '.gitlab-ci.yaml',
    '.circleci/config.yml',
    'makefile',
    'GNUmakefile',
    'vars.tfvars',
    'Containerfile',
    'ansible/site.yml',
    '.buildkite/pipeline.yml',
    'serverless.yml',
    'Taskfile.yml',
    'charts/app/values.yaml',
    'charts/values.yaml',
    'charts/app/nested/values.yml',
    'Vagrantfile',
    'Pulumi.yaml',
    '.dockerignore',
    'infra/main.bicep',
    'skaffold.yaml',
  ]
  const mustNotHit = ['src/app.ts', 'README.md', 'package.json', 'apps/web/src/main.tsx']

  it('CI/CD, containers, IaC, deploy, host/config-as-code hit', () => {
    for (const p of mustHit) {
      expect({ path: p, hit: infraHit([p]) }).toEqual({ path: p, hit: true })
    }
  })

  it('application source, docs, package manifests miss', () => {
    for (const p of mustNotHit) {
      expect({ path: p, hit: infraHit([p]) }).toEqual({ path: p, hit: false })
    }
  })

  it('nested scripts/ at F-lite → R-devops not R-architect', () => {
    const out = roster({ delta: ['apps/web/scripts/build.sh'], tier: 'F-lite' })
    expect(out.agents).toContain('R-devops')
    expect(out.agents).not.toContain('R-architect')
    expect(gate(out, 'R-devops')).toMatchObject({ spawn: true, reason: 'infra' })
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: false, reason: 'no-structure' })
  })
})

describe('hasAxialAdr errors', () => {
  it('ENOENT is warning-free', () => {
    const warnings: string[] = []
    expect(hasAxialAdr(join(dir, 'missing'), warnings)).toBe(false)
    expect(warnings).toEqual([])
  })

  it('ENOTDIR (file, not dir) is warning-free', () => {
    const file = join(dir, 'not-a-dir')
    writeFileSync(file, 'x')
    const warnings: string[] = []
    expect(hasAxialAdr(file, warnings)).toBe(false)
    expect(warnings).toEqual([])
  })

  it('unreadable dir warns', () => {
    const adr = join(dir, 'locked')
    mkdirSync(adr)
    writeFileSync(join(adr, 'x.md'), 'axial: true\n')
    chmodSync(adr, 0)
    const warnings: string[] = []
    try {
      expect(hasAxialAdr(adr, warnings)).toBe(false)
      expect(warnings.some((w) => w.startsWith('axial ADR dir unreadable:'))).toBe(true)
    } finally {
      chmodSync(adr, 0o700)
    }
  })

  it('unreadable member file continues and finds sibling axial: true', () => {
    if (RUNNING_AS_ROOT) return
    const adr = join(dir, 'adr')
    mkdirSync(adr)
    const locked = join(adr, '0001-locked.md')
    writeFileSync(locked, 'not axial\n')
    writeFileSync(join(adr, '0002-real.md'), 'axial: true\n')
    chmodSync(locked, 0o000)
    const warnings: string[] = []
    try {
      expect(hasAxialAdr(adr, warnings)).toBe(true)
      expect(warnings.some((w) => w.includes(locked) && w.includes('unreadable'))).toBe(true)
    } finally {
      chmodSync(locked, 0o644)
    }
  })
})

describe('filesystem error policy', () => {
  it('unreadable stack.yml warns naming the file and applies defaults', () => {
    if (RUNNING_AS_ROOT) return
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/foo.ts\n')
    const stack = join(dir, 'stack.yml')
    writeFileSync(stack, 'review:\n  roster:\n    max_agents: 9\n    verify_below_confidence: 10\n')
    chmodSync(stack, 0o000)
    try {
      const proc = spawnSync('bun', [ROSTER, '--diff-list', delta, '--stack', stack, '--json'], { encoding: 'utf8' })
      expect(proc.status).toBe(0)
      const json = JSON.parse(proc.stdout) as {
        max_agents: number
        warnings: string[]
      }
      expect(json.max_agents).toBe(3)
      expect(Object.hasOwn(json, 'verify_below_confidence')).toBe(false)
      expect(json.warnings.some((w) => w.includes(stack) && w.includes('unreadable'))).toBe(true)
    } finally {
      chmodSync(stack, 0o644)
    }
  })

  it('--diff-list that is a directory warns and exits 1', () => {
    const asDir = join(dir, 'not-a-file')
    mkdirSync(asDir)
    const proc = spawnSync('bun', [ROSTER, '--diff-list', asDir, '--json'], { encoding: 'utf8' })
    expect(proc.status).toBe(1)
    expect(proc.stderr).toContain(asDir)
    expect(proc.stderr).toMatch(/unreadable/)
  })
})
