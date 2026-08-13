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
