import { describe, it, expect, afterEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  setResolvedResourceTimeouts,
  resolvedResourceTimeoutMs,
  clearResolvedResourceTimeouts,
  type ResolvedResourceTimeouts,
} from '../../../src/provisioning/resource-timeout-registry.js';
import type { ResourceTimeoutOption } from '../../../src/cli/options.js';

// Type-level pin: the registry re-declares `ResourceTimeoutOption`'s shape
// locally (so the provisioning layer does not import CLI types). Because every
// registry field is optional, plain assignability would be vacuously true —
// instead pin that each registry key EXISTS on the CLI type (a CLI-side rename
// of `globalMs` / `perTypeMs` turns the mapped property to `never` and this
// fails `vp run typecheck:test`), and that the CLI value types stay assignable.
const _registryKeysExistOnCliType: {
  [K in keyof Required<ResolvedResourceTimeouts>]: K extends keyof ResourceTimeoutOption
    ? true
    : never;
} = { globalMs: true, perTypeMs: true };
void _registryKeysExistOnCliType;
const _cliValueTypesAssignable: ResolvedResourceTimeouts = {} as Pick<
  ResourceTimeoutOption,
  keyof ResolvedResourceTimeouts & keyof ResourceTimeoutOption
>;
void _cliValueTypesAssignable;

// Issue #1280: the process-wide registry that lets a provider's INNER waiter
// cap (ECS settleService under --full-wait) respect the user's
// `--resource-timeout` the way the deploy engine's OUTER deadline already
// does. These cases pin the resolution order (per-type > global > nothing)
// and that the unseeded state resolves to undefined — the compile-time 30m
// default must NOT leak in here (only an EXPLICIT user value may lift an
// inner waiter's own floor).

describe('resource-timeout registry (issue #1280)', () => {
  afterEach(() => {
    clearResolvedResourceTimeouts();
  });

  it('resolves to undefined when never seeded', () => {
    expect(resolvedResourceTimeoutMs('AWS::ECS::Service')).toBeUndefined();
  });

  it('resolves to undefined when seeded with undefined (flag not supplied)', () => {
    setResolvedResourceTimeouts(undefined);
    expect(resolvedResourceTimeoutMs('AWS::ECS::Service')).toBeUndefined();
  });

  it('resolves the global value for any type', () => {
    setResolvedResourceTimeouts({ globalMs: 1_200_000, perTypeMs: {} });
    expect(resolvedResourceTimeoutMs('AWS::ECS::Service')).toBe(1_200_000);
    expect(resolvedResourceTimeoutMs('AWS::S3::Bucket')).toBe(1_200_000);
  });

  it('resolves the global value when perTypeMs is absent entirely', () => {
    setResolvedResourceTimeouts({ globalMs: 1_200_000 });
    expect(resolvedResourceTimeoutMs('AWS::ECS::Service')).toBe(1_200_000);
  });

  it('per-type override wins over the global value', () => {
    setResolvedResourceTimeouts({
      globalMs: 1_200_000,
      perTypeMs: { 'AWS::ECS::Service': 2_400_000 },
    });
    expect(resolvedResourceTimeoutMs('AWS::ECS::Service')).toBe(2_400_000);
    expect(resolvedResourceTimeoutMs('AWS::S3::Bucket')).toBe(1_200_000);
  });

  it('per-type-only input leaves other types undefined', () => {
    setResolvedResourceTimeouts({ perTypeMs: { 'AWS::ECS::Service': 900_000 } });
    expect(resolvedResourceTimeoutMs('AWS::ECS::Service')).toBe(900_000);
    expect(resolvedResourceTimeoutMs('AWS::S3::Bucket')).toBeUndefined();
  });

  it('re-seeding replaces the previous value entirely', () => {
    setResolvedResourceTimeouts({ globalMs: 1_200_000, perTypeMs: {} });
    setResolvedResourceTimeouts({ perTypeMs: { 'AWS::ECS::Service': 900_000 } });
    expect(resolvedResourceTimeoutMs('AWS::S3::Bucket')).toBeUndefined();
  });

  it('clear resets to the unseeded state', () => {
    setResolvedResourceTimeouts({ globalMs: 1_200_000, perTypeMs: {} });
    clearResolvedResourceTimeouts();
    expect(resolvedResourceTimeoutMs('AWS::ECS::Service')).toBeUndefined();
  });
});

// Wiring pin — same pattern as the applyWaitFlagEnv pin in
// tests/unit/cli/options.test.ts. The registry only works when every command
// that parses `--resource-timeout` seeds it; a command added (or a call
// removed) without seeding silently reverts the inner waiter to its floor.
describe('resource-timeout registry seeding (source-level pin)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const seedingCommands = ['deploy.ts', 'destroy.ts', 'state.ts'];

  it.each(seedingCommands)(
    '%s seeds the registry right after validateResourceTimeouts',
    (file) => {
      const src = readFileSync(join(repoRoot, 'src', 'cli', 'commands', file), 'utf8');
      // Seeding must come AFTER validation so only validated values land in
      // the registry. Match on LIVE lines only — a commented-out call
      // (`// setResolvedResourceTimeouts(...)`) must fail this pin, not
      // satisfy it.
      const liveLines = src
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      const validateIdx = liveLines.indexOf('validateResourceTimeouts(options)');
      const seedIdx = liveLines.indexOf('setResolvedResourceTimeouts(options.resourceTimeout)');
      expect(validateIdx, `${file}: validateResourceTimeouts call not found`).toBeGreaterThan(-1);
      expect(
        seedIdx,
        `${file}: live (non-commented) setResolvedResourceTimeouts call not found`
      ).toBeGreaterThan(-1);
      expect(seedIdx, `${file}: seeding must follow validation`).toBeGreaterThan(validateIdx);
    }
  );
});
