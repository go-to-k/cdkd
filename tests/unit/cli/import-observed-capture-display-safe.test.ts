/**
 * go-to-k/cdkd#3479: the observed-baseline capture's two `debug` lines named
 * the template's logical id and type raw. They now take `logicalIdShown` /
 * `resourceTypeShown`, the spelling their neighbours already used, so a
 * non-plain value is DESCRIBED rather than printed. Driven through the
 * exported `captureObservedForImportedResources`, the way
 * `import-observed-baseline-refusal-matrix.test.ts` drives it.
 */

import { describe, expect, it, vi } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const { captureObservedForImportedResources, ObservedBaselineRefusals } = await import(
  '../../../src/cli/commands/import.js'
);
const { getLogger } = await import('../../../src/utils/logger.js');

const LS = String.fromCharCode(0x2028);
const ID = `Bad${LS}IDFORGED`;
const TYPE = `AWS::SQS::Queue${LS}TYPEFORGED`;

async function capture(refused: boolean, readCurrentState: () => Promise<unknown>) {
  debugSpy.mockClear();
  const state: StackState = {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'S',
    region: 'us-east-1',
    resources: { [ID]: { physicalId: 'p', resourceType: TYPE, properties: { A: 'b' } } },
    outputs: {},
    lastModified: 0,
  } satisfies StackState;
  const registry = {
    getProviderFor: () => ({ provider: { readCurrentState }, provisionedBy: 'sdk' }),
  } as unknown as Parameters<typeof captureObservedForImportedResources>[1];
  await captureObservedForImportedResources(
    state,
    registry,
    getLogger(),
    new ObservedBaselineRefusals(refused ? [ID] : []),
    new Set([ID])
  );
  return debugSpy.mock.calls.map((c) => String(c[0]));
}

describe('observed-baseline capture debug lines describe a non-plain id and type (go-to-k/cdkd#3479)', () => {
  it('the SKIPPED line', async () => {
    const lines = await capture(true, async () => ({ A: 'b' }));
    const line = lines.find((l) => l.startsWith('observedProperties capture SKIPPED'));
    expect(line).toBeDefined();
    expect(line).not.toContain(LS);
    expect(line).not.toContain('IDFORGED');
    expect(line).not.toContain('TYPEFORGED');
    expect(line).toContain(
      'SKIPPED for imported a logical id that is not a plain identifier (a resource type that is not a plain identifier)'
    );
  });

  it('the capture-failed line', async () => {
    const lines = await capture(false, async () => {
      throw new Error('read failed');
    });
    const line = lines.find((l) => l.startsWith('observedProperties capture for imported'));
    expect(line).toBeDefined();
    expect(line).not.toContain(LS);
    expect(line).not.toContain('IDFORGED');
    expect(line).not.toContain('TYPEFORGED');
  });
});
