import { FIELD_MAP } from '../../shared/config'
import { getItemId, updateField } from '../../shared/github'

export async function handleUpdate(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { issueNumber: number; field: string; value: string }
    const { issueNumber, field, value } = body

    const fieldConfig = FIELD_MAP[field]
    if (!fieldConfig)
      return Response.json({ ok: false, error: `Unknown field: ${field}` }, { status: 400 })

    const optionId = fieldConfig.options[value]
    if (!optionId)
      return Response.json({ ok: false, error: `Unknown value: ${value}` }, { status: 400 })

    const itemId = await getItemId(issueNumber)
    await updateField(itemId, fieldConfig.fieldId, optionId)

    return Response.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ ok: false, error: msg }, { status: 500 })
  }
}
