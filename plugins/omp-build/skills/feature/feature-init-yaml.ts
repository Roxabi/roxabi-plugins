export type YamlMap = Record<string, unknown>
export function isMap(value: unknown): value is YamlMap {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function bunYamlParse(text: string): unknown {
  if (typeof Bun === 'undefined' || typeof Bun.YAML?.parse !== 'function') {
    throw new Error('reading YAML needs bun >= 1.2.21 (Bun.YAML)')
  }
  return Bun.YAML.parse(text)
}
