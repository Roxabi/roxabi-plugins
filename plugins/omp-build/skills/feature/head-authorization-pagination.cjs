'use strict'

function validateVariablesNext(value, root, page) {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    !url.pathname.endsWith(`/${root}/actions/variables`) ||
    url.searchParams.get('per_page') !== '100' ||
    url.searchParams.get('page') !== String(page + 1) ||
    [...url.searchParams.keys()].length !== 2
  )
    throw new Error('invalid variables next page')
}

function variablesNext(headers, root, page) {
  const lines = headers.split(/\r?\n/).filter((line) => /^link:/i.test(line))
  if (lines.length > 1) throw new Error('ambiguous variables pagination')
  let next = false
  if (lines.length) {
    for (const link of lines[0].slice(lines[0].indexOf(':') + 1).split(',')) {
      const match = link.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/)
      if (!match) throw new Error('invalid variables pagination link')
      if (match[2] !== 'next') continue
      if (next) throw new Error('duplicate variables pagination link')
      validateVariablesNext(match[1], root, page)
      next = true
    }
  }
  return next
}

function commentsNext(headers, root, prNumber, page) {
  const lines = headers.split(/\r?\n/).filter((line) => /^link:/i.test(line))
  if (lines.length > 1) throw new Error('ambiguous pagination headers')
  if (!lines.length) return false
  const links = lines[0].slice(lines[0].indexOf(':') + 1).split(',')
  let next = false
  for (const link of links) {
    const match = link.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/)
    if (!match) throw new Error('invalid pagination link')
    if (match[2] !== 'next') continue
    if (next) throw new Error('duplicate pagination link')
    const url = new URL(match[1])
    if (
      url.protocol !== 'https:' ||
      !url.pathname.endsWith(`/${root}/issues/${prNumber}/comments`) ||
      url.searchParams.get('per_page') !== '100' ||
      url.searchParams.get('page') !== String(page + 1) ||
      [...url.searchParams.keys()].length !== 2
    )
      throw new Error('invalid next page')
    next = true
  }
  return next
}

module.exports = { variablesNext, commentsNext }
