export interface Formatter {
  cmd: string
  ext: string[] | null
}

export interface StackCommands {
  lint: string | null
  typecheck: string | null
  test: string | null
}

export interface StackYml {
  formatters: Formatter[] | null
  singleFormatterCmd: string | null
  platform: string | null
  frontend: string | null
  packageManager: string | null
  standards: Record<string, string> | null
  runtime: string | null
  commands: StackCommands
  testingUnit: string | null
  testingE2e: string | null
  ciMerge: string | null
}

export declare function parseStackYml(text: string | null): StackYml
export declare function parseFormatters(text: string | null): Formatter[] | null
export declare function parseSingleFormatterCmd(text: string | null): string | null
export declare function parsePlatform(text: string | null): string | null
export declare function parseFrontendFramework(text: string | null): string | null
export declare function parsePackageManager(text: string | null): string | null
export declare function parseStandards(text: string | null): Record<string, string> | null
export declare function parseRuntime(text: string | null): string | null
export declare function parseCommand(text: string | null, key: string): string | null
export declare function parseTestingUnit(text: string | null): string | null
export declare function parseTestingE2e(text: string | null): string | null
export declare function parseCiMerge(text: string | null): string | null