/**
 * Type declarations for `refresh-cfn-schemas.mjs` (a `@ts-check` JS module),
 * so TypeScript consumers — `tests/unit/scripts/gen-nested-key-coverage.test.ts`
 * imports {@link extractNestedPropertyNames} to unit-test the fixture capture —
 * typecheck under `tsconfig.test.json` without an implicit-any error.
 */
export declare function fixtureFilename(type: string): string;
export declare function extractRegisteredTypes(source: string): string[];
export declare function extractTopLevelProperties(schemaJson: string): string[];
export declare function extractReadOnlyProperties(schemaJson: string): string[];
export declare function extractCreateOnlyProperties(schemaJson: string): string[];
export declare function extractPrimaryIdentifier(schemaJson: string): string[];
export declare function extractNestedPropertyNames(schemaJson: string): Record<string, string[]>;
export declare function extractNestedPropertyPaths(
  schemaJson: string,
  typeName?: string
): Record<string, string[]>;
export declare function extractDefinitionShapes(
  schemaJson: string
): Record<string, Record<string, string>>;
export declare function extractDefinitionRequired(
  schemaJson: string
): Record<string, string[]>;
export declare function buildFixture(
  schemaJson: string,
  resourceType: string,
  generatedAt: string
): {
  resourceType: string;
  generatedAt: string;
  properties: string[];
  readOnlyProperties: string[];
  createOnlyProperties: string[];
  primaryIdentifier: string[];
} & Record<string, unknown>;
export declare function serializeFixture(fixture: Record<string, unknown>): string;
export declare function fixtureDiffersIgnoringDate(
  candidate: Record<string, unknown>,
  committedText: string | undefined
): boolean;
export declare function zipEntryName(type: string): string;
export declare function readSchemaBundle(zipBuffer: Buffer): Map<string, string>;
export declare function refreshFixturesFromEntries(args: {
  entries: ReadonlyMap<string, string>;
  types: readonly string[];
  fixturesDir: string;
  generatedAt: string;
  writeFixture: (path: string, text: string) => void;
  readFixture: (path: string) => string | undefined;
}): {
  drifted: string[];
  unchanged: string[];
  missing: string[];
  failed: Array<{ type: string; error: string }>;
};
export declare function downloadSchemaBundle(
  url: string,
  fetchImpl?: (url: string, init?: unknown) => Promise<unknown>
): Promise<Buffer>;
