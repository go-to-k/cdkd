/**
 * Capture every resource type's registry-schema `createOnlyProperties` PATHS
 * from the public CloudFormation schema bundle into
 * `tests/fixtures/cfn-registry-create-only-paths.json` (go-to-k/cdkd#7070).
 *
 * The committed snapshot is the "schema says mutable" side of
 * `scripts/spec-replacement-candidates.ts`: the spec rows it calls a
 * replacement are candidates only where this snapshot leaves the path
 * mutable. Taking it from a committed file keeps `gen:spec-replacement-properties`
 * and its `--check` OFFLINE; this script is the only part that needs the
 * network, and it is deliberately outside `gen:all-matrices`.
 *
 * The download and unzip reuse `refresh-cfn-schemas.mjs` (origin pinned, no
 * redirect, size caps), and the path parse is the live resolver's own
 * (`extractCreateOnlyPropertyPaths`), so the snapshot cannot spell a path the
 * runtime would not.
 */

import { renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  downloadSchemaBundle,
  extractCreateOnlyPropertyPaths,
  readSchemaBundle,
} from './refresh-cfn-schemas.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT_PATH = resolve(repoRoot, 'tests/fixtures/cfn-registry-create-only-paths.json');
const bundleUrl = (region: string): string =>
  `https://schema.cloudformation.${region}.amazonaws.com/CloudformationSchema.zip`;
const BUNDLE_URL = bundleUrl('us-east-1');
/**
 * Regions read, in order, for a type the us-east-1 bundle lacks: a type
 * offered only elsewhere (Device Farm is us-west-2 only) still has a schema.
 */
export const FALLBACK_REGIONS = ['us-west-2', 'eu-west-1', 'eu-central-1', 'ap-northeast-1'] as const;
/** Fewer types than this is a truncated or replaced bundle, never a refresh. */
const MIN_TYPES = 1500;

export interface RegistryCreateOnlySnapshot {
  readonly _comment: readonly string[];
  readonly source: string;
  /** A type absent from us-east-1 -> the fallback region its schema came from. */
  readonly homeRegions: Readonly<Record<string, string>>;
  /** Resource type -> its create-only paths (segments after `/properties/`). */
  readonly types: Readonly<Record<string, readonly (readonly string[])[]>>;
}

/**
 * Build the snapshot from bundle entries (entry name -> schema JSON): the
 * us-east-1 bundle first, then each fallback region's for the types it lacks.
 */
export function buildSnapshot(
  entries: ReadonlyMap<string, string>,
  fallbacks: ReadonlyArray<readonly [region: string, entries: ReadonlyMap<string, string>]> = []
): RegistryCreateOnlySnapshot {
  const types: Record<string, string[][]> = {};
  const homeRegions: Record<string, string> = {};
  const read = (bundle: ReadonlyMap<string, string>, region?: string): void => {
    for (const schemaJson of bundle.values()) {
      const typeName = (JSON.parse(schemaJson) as { typeName?: unknown }).typeName;
      if (typeof typeName !== 'string' || typeName in types) continue;
      types[typeName] = extractCreateOnlyPropertyPaths(schemaJson);
      if (region !== undefined) homeRegions[typeName] = region;
    }
  };
  read(entries);
  if (Object.keys(types).length < MIN_TYPES) {
    throw new Error(
      `the us-east-1 schema bundle carries ${Object.keys(types).length} types (floor ${MIN_TYPES}) — refusing to write a truncated snapshot`
    );
  }
  for (const [region, bundle] of fallbacks) read(bundle, region);
  const sorted: Record<string, string[][]> = {};
  for (const type of Object.keys(types).sort()) sorted[type] = types[type]!;
  const sortedHome: Record<string, string> = {};
  for (const type of Object.keys(homeRegions).sort()) sortedHome[type] = homeRegions[type]!;
  return {
    _comment: [
      'Every resource type in the public CloudFormation registry schema bundle (us-east-1, then',
      `${FALLBACK_REGIONS.join(', ')} for a type it lacks) with its createOnlyProperties paths.`,
      'Read OFFLINE by scripts/spec-replacement-candidates.ts',
      '(go-to-k/cdkd#7070). Refresh: `vp run gen:cfn-registry-create-only-paths` (network).',
    ],
    source: BUNDLE_URL,
    homeRegions: sortedHome,
    types: sorted,
  };
}

/** One type per line, so a refresh diffs per type. */
export function serializeSnapshot(snapshot: RegistryCreateOnlySnapshot): string {
  const lines = [
    '{',
    `  "_comment": ${JSON.stringify(snapshot._comment)},`,
    `  "source": ${JSON.stringify(snapshot.source)},`,
    `  "homeRegions": ${JSON.stringify(snapshot.homeRegions)},`,
    '  "types": {',
  ];
  const entries = Object.entries(snapshot.types);
  entries.forEach(([type, paths], i) => {
    lines.push(`    ${JSON.stringify(type)}: ${JSON.stringify(paths)}${i < entries.length - 1 ? ',' : ''}`);
  });
  lines.push('  }', '}', '');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const entries = readSchemaBundle(await downloadSchemaBundle(BUNDLE_URL));
  const fallbacks: Array<readonly [string, ReadonlyMap<string, string>]> = [];
  for (const region of FALLBACK_REGIONS) {
    fallbacks.push([region, readSchemaBundle(await downloadSchemaBundle(bundleUrl(region)))]);
  }
  const snapshot = buildSnapshot(entries, fallbacks);
  const tmp = `${SNAPSHOT_PATH}.tmp`;
  writeFileSync(tmp, serializeSnapshot(snapshot));
  renameSync(tmp, SNAPSHOT_PATH);
  process.stderr.write(
    `registry-create-only-paths: wrote ${Object.keys(snapshot.types).length} types\n`
  );
}

if (Boolean(process.argv[1]) && resolve(process.argv[1]!) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`registry-create-only-paths: failed — ${(err as Error).message}\n`);
    process.exit(1);
  });
}
