export type Child = {
  number: number
  title: string
  blockedBy: number[]
  hasScope: boolean
}

export function generateObjective(
  epic: { number: number },
  children: Child[],
): { objective: string; order: number[] } | { error: string } {
  const missing = children.filter((child) => !child.hasScope).map((child) => child.number)
  if (missing.length) return { error: `missing scope: ${missing.join(', ')}` }

  const pending = new Map(children.map((child) => [child.number, child.blockedBy.length]))
  const ready = children.filter((child) => child.blockedBy.length === 0).map((child) => child.number)
  const order: number[] = []
  while (ready.length) {
    const number = ready.shift()
    if (number === undefined) break
    order.push(number)
    for (const child of children) {
      if (!child.blockedBy.includes(number)) continue
      const left = (pending.get(child.number) ?? 0) - 1
      pending.set(child.number, left)
      if (left === 0) ready.push(child.number)
    }
  }
  if (order.length !== children.length) return { error: 'cycle' }

  const objective = [
    `Livrer l'epic #${epic.number}.`,
    `Ordre: ${order.join(' → ')}.`,
    'Ticket arrêté → rapport, continuer les indépendants, sauter les dépendants.',
    'CI rouge sur main → goal drop + rapport.',
    "Terminé quand tous les enfants sont fermés par une PR mergée et la revue finale n'a aucun bloquant.",
  ].join(' ')
  return { objective, order }
}

export function resolveTicketBranch(branch: string, children: number[]): { ticket: number } | { error: string } {
  const match = branch.match(/\/(\d+)-/)
  if (!match) return { error: 'no ticket' }
  const ticket = Number(match[1])
  if (!children.includes(ticket)) return { error: 'foreign ticket' }
  return { ticket }
}

export function refuseForeignCommits(
  commits: { sha: string; ticket: number | null }[],
  ticket: number,
): { ok: true } | { error: string } {
  const foreign = commits.find((commit) => commit.ticket !== ticket)
  if (foreign) return { error: `foreign commit ${foreign.sha}` }
  return { ok: true }
}
