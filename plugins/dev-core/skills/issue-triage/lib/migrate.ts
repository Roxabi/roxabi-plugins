/**
 * migrate.ts — taxonomy migration subcommands: audit-schema, backfill, rewrite-titles, revert.
 * See artifacts/specs/121-dual-write-migration-spec.mdx.
 */

import {
  GH_PROJECT_ID,
  LANE_OPTIONS,
  PRIORITY_OPTIONS,
  SIZE_OPTIONS,
  STATUS_OPTIONS,
} from '../../shared/adapters/config-helpers'
import { ghGraphQL } from '../../shared/adapters/github-adapter'

interface FieldSchema {
  id: string
  name: string
  options: Array<{ id: string; name: string }>
}

const PROJECT_FIELDS_QUERY = `
  query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: 50) {
          nodes {
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name }
            }
          }
        }
      }
    }
  }
`

const EXPECTED_FIELDS: Array<{ name: string; options: Record<string, string> }> = [
  { name: 'Size', options: SIZE_OPTIONS },
  { name: 'Lane', options: LANE_OPTIONS },
  { name: 'Priority', options: PRIORITY_OPTIONS },
  { name: 'Status', options: STATUS_OPTIONS },
]

export async function auditSchema(): Promise<void> {
  const data = (await ghGraphQL(PROJECT_FIELDS_QUERY, { projectId: GH_PROJECT_ID })) as {
    node: {
      fields: {
        nodes: Array<Partial<FieldSchema>>
      }
    }
  }

  const liveNodes = data.node.fields.nodes.filter((n): n is FieldSchema => Array.isArray((n as FieldSchema).options))

  const liveByName = new Map<string, FieldSchema>(liveNodes.map((n) => [n.name, n]))

  const diffs: string[] = []

  for (const expected of EXPECTED_FIELDS) {
    const liveField = liveByName.get(expected.name)

    if (!liveField) {
      diffs.push(`MISSING: ${expected.name}`)
      continue
    }

    const liveOptionNames = new Set(liveField.options.map((o) => o.name))
    const localOptionNames = new Set(Object.keys(expected.options))

    for (const local of localOptionNames) {
      if (!liveOptionNames.has(local)) {
        diffs.push(`LOCAL_EXTRA: ${expected.name}.${local}`)
      }
    }

    for (const live of liveOptionNames) {
      if (!localOptionNames.has(live)) {
        diffs.push(`LOCAL_MISSING: ${expected.name}.${live}`)
      }
    }
  }

  if (diffs.length > 0) {
    for (const line of diffs) {
      console.log(line)
    }
    process.exit(1)
  }

  console.log('audit-schema: OK — Size/Lane/Priority/Status match live project')
}
