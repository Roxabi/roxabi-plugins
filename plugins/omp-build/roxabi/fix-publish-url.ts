function credentialFreeScheme(scheme: string | undefined, rest: string): boolean {
  if (rest.includes('?') || rest.includes('#') || (scheme !== 'file' && rest.includes('\\'))) return false
  const authority = rest.split(/[/?#\\]/, 1)[0] ?? ''
  if (scheme === 'file') return !authority.includes('@')
  if (authority.length === 0) return false
  if (scheme === 'http' || scheme === 'https' || scheme === 'git') return !authority.includes('@')
  if (scheme === 'ssh') return !authority.includes('@') || /^(?:git|org-[0-9]+)@[^@]+$/.test(authority)
  return false
}

/** Reject credentials or ambiguous transport syntax before a push URL is persisted or executed. */
export function credentialFreePushUrl(value: string): boolean {
  if (value.length === 0 || value.startsWith('-') || /[\s\p{Cc}]/u.test(value) || value.includes('::')) return false
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value)
  if (match !== null) return credentialFreeScheme(match[1]?.toLowerCase(), value.slice(match[0].length))
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true
  const colon = value.indexOf(':')
  const slash = value.indexOf('/')
  if (slash !== -1 && (colon === -1 || slash < colon)) return true
  return (
    colon > 0 &&
    /^(?:(?:git|org-[0-9]+)@)?[A-Za-z0-9.-]+$/.test(value.slice(0, colon)) &&
    !/^[^/\\]*@[^/\\]*:/.test(value.slice(colon + 1))
  )
}
