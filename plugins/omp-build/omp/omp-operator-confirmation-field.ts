export function summaryField(trustedPrefix: string, rawValue: string): string {
  return `${trustedPrefix}${JSON.stringify(rawValue)}`
}
