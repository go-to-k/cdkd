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
  /** Whether `clientsForType` matched this client to the type's own service. */
  matched?: boolean;
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
): { client: string; modelled: boolean; version?: string; consulted?: string[] } | undefined;
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
export declare function renderDiagnosis(input: {
  removed: RemovedEntry[];
  writableAdded: AddedEntry[];
  readOnlyAddedCount?: number;
  sdkLag?: SdkLagRow[];
  divergences: NestedKeyDivergence[];
  nestedKeyUnparsed?: boolean;
  skipped: string[];
}): string;
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
