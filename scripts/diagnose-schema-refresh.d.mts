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
  /** Removed properties the job settled itself, rendered in their own section. */
  autoTolerated?: Array<{ resourceType: string; property: string; rationale: string }>;
  /** Removed properties the job REFUSED to settle, with the test that failed. */
  autoEscalated?: Array<{ resourceType: string; property: string; reason: string }>;
  skipped: string[];
}
export declare function renderDiagnosis(input: DiagnosisInput): string;
/**
 * How many things in this refresh need a human decision — the number a refresh
 * PR is labelled, retitled and assigned from. `renderDiagnosis` calls it rather
 * than restating the condition, so the marking and the prose beneath it cannot
 * disagree.
 */
export declare function countDecisions(
  input: Pick<DiagnosisInput, 'removed' | 'divergences'> &
    Partial<Pick<DiagnosisInput, 'nestedKeyUnparsed' | 'failedChecks' | 'unreadable'>>
): number;
export declare function sdkVersionLag(
  client: string,
  installed: string | undefined,
  viewLatest?: (pkg: string) => string
): { installed: string; latest: string; behind: boolean } | undefined;
export declare function pairRenames(property: string, writableAdded: readonly string[]): string[];
export declare function renderName(name: string): string;
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
export declare const KNOWN_FLAGS: string[];
export declare function assertFixtureFloor(fixtureCount: number, declaredCount: number): void;
/** What `--umbrella-checklist` emits when the campaign is finished. */
export declare const UMBRELLA_EMPTY_SENTINEL: string;
/** The rows, or `UMBRELLA_EMPTY_SENTINEL` when there are none. */
export declare function renderUmbrellaDocument(generatedSource: string): string;
/** One `- [ ] \`Type\`: \`Prop\`` row per remaining silent-drop property. */
export declare function renderUmbrellaChecklist(generatedSource: string): string[];
/**
 * Whether the refresh job may settle a removed-but-declared property itself.
 * `auto` only when there is no rename candidate on the type, the type's own SDK
 * client declares a member of the name, and the provider wires it.
 */
export declare function classifyRemovedProperty(input: {
  property: string;
  client: string | undefined;
  providerRelPath: string | undefined;
  renameCandidates: readonly string[];
  /**
   * Names ALREADY in the type's current schema that pair with this one — the
   * cross-cycle half of the rename check, which `renameCandidates` cannot see.
   */
  schemaRenameCandidates?: readonly string[];
  /**
   * Structural, NOT `typeof import('./offline-property-evidence.ts')`. That
   * spelling drags the whole module's import graph in, and this file is
   * type-checked standalone with `skipLibCheck` OFF — where the installed
   * `@aws-sdk/client-*` tree's own `@smithy/types` version skew surfaces as
   * errors that have nothing to do with these declarations. The duplication is
   * checked rather than mirrored: `main()` passes the real functions in, so a
   * signature change that does not fit fails at that call site.
   */
  typedMember: (
    property: string,
    clientPackage: string,
    repoRoot?: string
  ) =>
    | { client: string; spelling: 'exact' | 'lowerFirst'; interfaces: readonly string[] }
    | undefined;
  wires: (
    property: string,
    providerRelPath: string | undefined,
    repoRoot?: string
  ) => { sites: readonly string[] } | undefined;
  repoRoot?: string;
}): { auto: false; reason: string } | { auto: true; rationale: string };
/**
 * Apply the classifier across every removed entry, writing the settled ones into
 * `_todo-backfill.json`'s `bogusTolerated` and reporting both outcomes.
 */
export declare function writeAutoTolerated(
  removed: RemovedEntry[],
  providerFiles: Map<string, string>,
  repoRoot?: string
): {
  written: Array<{ resourceType: string; property: string; rationale: string }>;
  escalated: Array<{ resourceType: string; property: string; reason: string }>;
};
