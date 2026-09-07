/**
 * Type declarations for `diagnose-schema-refresh.mjs` (a `@ts-check` JS module),
 * so its unit test typechecks under `tsconfig.test.json`.
 */
export interface NestedKeyDivergence {
  resourceType: string;
  nestedKey: string;
  bucket: string;
  detail: string;
}
export interface SdkLagRow {
  resourceType: string;
  client: string;
  installed: string;
  latest: string;
  behind: boolean;
  /**
   * Whether the client was resolved to the type's own service. REQUIRED, not
   * optional: an omitted flag reads as `!== false` and renders the confident
   * "here", which is the fail-open direction a round-4 fix already shipped once.
   */
  matched: boolean;
}
export declare const NESTED_KEY_FAILURE_RE: RegExp;
export declare function comparePropertySets(
  committedJson: string,
  refreshedJson: string
): { removed: string[]; added: string[]; writableAdded: string[] };
export declare function parseNestedKeyDivergences(
  checkOutput: string,
  exitCode?: number
): {
  divergences: NestedKeyDivergence[];
  unparsedFailure: boolean;
};
export declare function mapTypesToProviderFiles(source: string): Map<string, string>;
export declare function findDeclarationCandidates(
  property: string,
  providerRelPath: string | undefined,
  resourceType?: string,
  repoRoot?: string
): string[];
export declare function sdkModelsMember(
  property: string,
  providerRelPath: string | undefined,
  repoRoot?: string
): SdkEvidence | undefined;
export declare function sdkClientVersions(
  providerRelPath: string | undefined,
  repoRoot?: string
): Array<{ client: string; version: string }>;
export declare function parseDeclaredProperties(
  generatedSource: string
): Map<string, Set<string>>;
export interface SdkEvidence {
  client: string;
  modelled: boolean;
  version?: string;
  consulted?: string[];
}
export interface RemovedEntry {
  resourceType: string;
  properties: string[];
  candidates: Record<string, string[]>;
  sdk?: Record<string, SdkEvidence | undefined>;
  renameCandidates?: Record<string, string[]>;
  providerPath?: string;
}
export interface AddedEntry {
  resourceType: string;
  properties: string[];
}
export interface DiagnosisInput {
  removed: RemovedEntry[];
  writableAdded: AddedEntry[];
  readOnlyAddedCount?: number;
  sdkLag?: SdkLagRow[];
  divergences: NestedKeyDivergence[];
  nestedKeyUnparsed?: boolean;
  failedChecks?: string[];
  unreadable?: string[];
  skipped: string[];
}
export declare function renderDiagnosis(input: DiagnosisInput): string;
export declare function sdkVersionLag(
  client: string,
  installed: string | undefined,
  viewLatest?: (pkg: string) => string
): { installed: string; latest: string; behind: boolean } | undefined;
export declare function pairRenames(property: string, writableAdded: readonly string[]): string[];
export declare function renderName(name: string): string;
export declare function renderLiteral(name: string): string;
export declare function renderKey(key: string): string;
export declare function renderDetail(text: string): string;
export declare function clientsForType(
  resourceType: string,
  rows: Array<{ client: string; version: string }>
): Array<{ client: string; version: string; matched: boolean }>;
export declare function buildSdkLag(
  divergences: Array<{ resourceType: string; bucket: string }>,
  clientsFor: (resourceType: string) => Array<{ client: string; version: string }>,
  versionLag?: (
    client: string,
    installed: string
  ) => { installed: string; latest: string; behind: boolean } | undefined
): SdkLagRow[];
export declare const UNREADABLE: unique symbol;
export declare const CHECK_GUIDANCE: Record<string, string[]>;
export declare function collectFixtureDeltas(input: {
  files: string[];
  committedOf: (file: string) => string | undefined | typeof UNREADABLE;
  currentOf: (file: string) => string;
  providerFiles: Map<string, string>;
  declared: Map<string, Set<string>>;
  declarationCandidates?: (
    property: string,
    providerRelPath: string | undefined,
    resourceType?: string,
    repoRoot?: string
  ) => string[];
  sdkEvidence?: (
    property: string,
    providerRelPath: string | undefined,
    repoRoot?: string
  ) => SdkEvidence | undefined;
}): {
  removed: RemovedEntry[];
  writableAdded: AddedEntry[];
  readOnlyAddedCount: number;
  unreadable: string[];
};
export declare function loadDeclaredProperties(repoRoot?: string): Map<string, Set<string>>;
export declare function classifyGitShowFailure(stderr: string): undefined | typeof UNREADABLE;
