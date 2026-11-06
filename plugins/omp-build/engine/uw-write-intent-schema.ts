import { z } from 'zod'

export const repositorySchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
export const issueRefSchema = z.strictObject({ repository: repositorySchema, number: z.number().int().positive() })
export const labelIntentSchema = z.strictObject({ add: z.array(z.string().min(1)), remove: z.array(z.string().min(1)) })
export const relationIntentSchema = z.strictObject({
  parent: issueRefSchema.nullable().optional(),
  addChildren: z.array(issueRefSchema),
  removeChildren: z.array(issueRefSchema),
  addBlockers: z.array(issueRefSchema),
  removeBlockers: z.array(issueRefSchema),
})
export const writesSchema = z.strictObject({ labels: labelIntentSchema, relations: relationIntentSchema })
