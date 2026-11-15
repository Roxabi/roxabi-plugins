import { describe, expect, it } from 'vitest'
import { credentialFreePushUrl } from './fix-publish-url.ts'

describe('credential-free push URLs', () => {
  it.each([
    'git@github.com:Acme/app.git',
    'git@github-work:Acme/app.git',
    'ssh://git@github.com/Acme/app.git',
    'ssh://git@github.com:22/Acme/app.git',
    'https://github.com/Acme/app.git',
    '/tmp/x/origin.git',
    '../local/origin.git',
  ])('accepts %s', (url) => expect(credentialFreePushUrl(url)).toBe(true))

  it.each([
    '',
    '-github.com/repo',
    'https://fixture-token@github.com/acme/app.git',
    'https://x-access-token:fixture-secret@github.com/acme/app.git',
    'https://:fixture-secret@github.com/acme/app.git',
    'ssh://git:fixture-secret@github.com/acme/app.git',
    'ssh://fixture-secret@github.com/acme/app.git',
    'fixture-secret@github.com:acme/app.git',
    'https://github.com/acme/app.git?access_token=fixture-secret',
    'https://github.com/acme/app.git#fixture-secret',
    'gcrypt::https://fixture-secret@github.com/acme/app.git',
    'https://github.com/acme/\napp.git',
    'git@github.com:\tacme/app.git',
  ])('refuses %s', (url) => expect(credentialFreePushUrl(url)).toBe(false))
})
