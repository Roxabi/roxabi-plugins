export interface Formatter {
  cmd: string
  ext: string[] | null
}

export interface StackYml {
  formatters: Formatter[] | null
  singleFormatterCmd: string | null
  platform: string | null
  frontend: string | null
  packageManager: string | null
  standards: Record<string, string> | null
}

export declare function parseStackYml(text: string | null): StackYml
export declare function parseFormatters(text: string | null): Formatter[] | null
export declare function parseSingleFormatterCmd(text: string | null): string | null
export declare function parsePlatform(text: string | null): string | null
export declare function parseFrontendFramework(text: string | null): string | null
export declare function parsePackageManager(text: string | null): string | null
export declare function parseStandards(text: string | null): Record<string, string> | null
