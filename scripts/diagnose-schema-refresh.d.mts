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
/**
 * A `definition-member-missing` divergence the PUBLISHED client already resolves
 * — the finding plus the bump that clears it (issue go-to-k/cdkd#2819).
 */
export interface PendingSdkBump extends NestedKeyDivergence {
  /** The client whose published version declares the member. */
  client: string;
  installed: string;
  latest: string;
  /** The SDK interface the checker's question was scoped to. */
  definition: string;
  /** The member name, in the SDK's own spelling. */
  member: string;
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
  /** Divergences a pending dependency bump resolves, rendered in their own section. */
  pendingSdkBump?: PendingSdkBump[];
  /**
   * Divergences the published client did not settle either way, so their
   * SDK-lag reading is unknown rather than ruled out. They stay in
   * `divergences`; this list only makes the procedure say so, instead of
   * claiming a check that never happened.
   */
  unresolvedSdkLag?: NestedKeyDivergence[];
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
    Partial<
      Pick<
        DiagnosisInput,
        'nestedKeyUnparsed' | 'failedChecks' | 'unreadable' | 'pendingSdkBump'
      >
    >
): number;
export declare function parseDefinitionMemberMissing(
  detail: string
): { definition: string; member: string } | undefined;
/** One entry per dependency bump, not per divergence. Sorted. */
export declare function pendingBumpGroups(
  pending: readonly PendingSdkBump[]
): Array<{ client: string; installed: string; latest: string }>;
export declare function partitionPendingSdkBump(input: {
  divergences: NestedKeyDivergence[];
  sdkLag?: SdkLagRow[];
  /**
   * Typed as `ReadonlyMap<..., unknown>` rather than as the producer's
   * `SdkMemberType` index. This file is type-checked by a CONFIG-LESS `tsc`
   * (see the sibling test), so importing from a `.ts` module is an error here
   * — and restating the member shape would be a second copy of a declaration
   * `gen-nested-key-coverage.ts` owns. The partition only ever asks whether a
   * NAME is present, so the read-only, value-agnostic spelling is both what it
   * needs and covariantly assignable from the real index.
   */
  publishedInterfaces?: (
    client: string,
    version: string
  ) => ReadonlyMap<string, ReadonlyMap<string, unknown>> | undefined;
}): {
  divergences: NestedKeyDivergence[];
  pendingSdkBump: PendingSdkBump[];
  /** The subset of `divergences` the published client did not settle either way. */
  unresolved: NestedKeyDivergence[];
};
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

/**
 * Flags that take no value, so a following token is never theirs.
 *
 * Exported for its fence: it is a second copy of a `KNOWN_FLAGS` fact, and a
 * boolean flag left out of it swallows the next token as a value.
 */
export declare const VALUELESS_FLAGS: ReadonlySet<string>;

/**
 * Classify an argv list the way `main()` does — one implementation, shared with
 * the entry point so the two cannot disagree about what a bad invocation is.
 */
export declare function classifyArgs(args: string[]): {
  unknown: string[];
  repeated: string[];
};
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
 * The evidence helpers `loadEvidenceDeps` resolves.
 *
 * Structural, for the config-less-`tsc` reason recorded on the loader below;
 * `typedSdkMember` / `providerWiresProperty` repeat the shapes
 * `classifyRemovedProperty` already declares for its own `typedMember` /
 * `wires` inputs, which is what those two are passed as.
 */
export interface EvidenceDeps {
  typedSdkMember: (
    property: string,
    clientPackage: string,
    repoRoot?: string
  ) =>
    | { client: string; spelling: 'exact' | 'lowerFirst'; interfaces: readonly string[] }
    | undefined;
  providerWiresProperty: (
    property: string,
    providerRelPath: string | undefined,
    repoRoot?: string
  ) => { sites: readonly string[] } | undefined;
  publishedSdkInterfaces: (
    client: string,
    version: string
  ) => ReadonlyMap<string, ReadonlyMap<string, unknown>> | undefined;
}

/**
 * Load the evidence helpers the non-checklist modes need.
 *
 * They are NOT imported at the top of the script: ESM resolves a module's whole
 * graph before any of its code runs, so a static import made
 * `--umbrella-checklist` die on `typescript-v6` in the sync workflow, which
 * deliberately installs nothing (issue
 * https://github.com/go-to-k/cdkd/issues/2858). Idempotent. The CLI calls it
 * before `main()` for every mode but the checklist; a caller reaching
 * `writeAutoTolerated` or `partitionPendingSdkBump` without it, and without
 * injecting doubles, gets a REFUSAL rather than a silent empty verdict.
 *
 * The members are declared STRUCTURALLY rather than imported: this file is
 * type-checked by a CONFIG-LESS `tsc` (see the sibling test), so it cannot
 * import from a `.ts` module — the same constraint the `partitionPendingSdkBump`
 * note above records. `unknown` was the first cut and is too weak to be worth
 * declaring: a caller passing `{}` compiles, the helpers read as `undefined`
 * callables, and the classifier's own `catch` turns that into "the evidence
 * could not be read" for every property — silence exactly where this contract
 * promises a refusal.
 */
export declare function loadEvidenceDeps(): Promise<EvidenceDeps>;

/**
 * Apply the classifier across every removed entry, writing the settled ones into
 * `_todo-backfill.json`'s `bogusTolerated` and reporting both outcomes.
 */
export declare function writeAutoTolerated(
  removed: RemovedEntry[],
  providerFiles: Map<string, string>,
  repoRoot?: string,
  deps?: EvidenceDeps
): {
  written: Array<{ resourceType: string; property: string; rationale: string }>;
  escalated: Array<{ resourceType: string; property: string; reason: string }>;
};
