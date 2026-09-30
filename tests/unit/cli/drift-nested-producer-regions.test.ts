/**
 * The producer-region evidence `cdkd drift` walks up a nested chain for, and
 * the refusal it takes when that walk cannot finish (go-to-k/cdkd#4213).
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  driftProducerRegionEvidence,
  refuseUnprovenDriftSecret,
} from '../../../src/cli/commands/drift.js';
import type { StackState } from '../../../src/types/state.js';

const REGION = 'us-east-1';
const NAME_EXPR = '{{resolve:secretsmanager:prod/db:SecretString:password}}';

function record(extra: Partial<StackState> & { reads?: string[] } = {}): StackState {
  const { reads, ...rest } = extra;
  return {
    version: 10,
    stackName: 'S',
    region: REGION,
    resources: {},
    outputs: {},
    lastModified: 0,
    ...(reads && {
      outputReads: reads.map((sourceRegion, i) => ({
        sourceStack: 'P',
        outputName: `O${i}`,
        sourceRegion,
      })),
    }),
    ...rest,
  } as StackState;
}

function backend(map: Record<string, unknown>) {
  return {
    getState: vi.fn(async (name: string, region: string) => {
      const entry = map[`${name}|${region}`];
      if (entry instanceof Error) throw entry;
      return (entry ?? null) as never;
    }),
  };
}

describe('driftProducerRegionEvidence', () => {
  it('a top-level record is its own reads, complete, and reads no other record', async () => {
    const b = backend({});
    await expect(
      driftProducerRegionEvidence(record({ reads: ['eu-west-1'] }), 'Top', REGION, b)
    ).resolves.toEqual({ regions: ['eu-west-1'], complete: true });
    expect(b.getState).not.toHaveBeenCalled();
  });

  it("a child unions its own reads first with the parent's, complete when the chain ends", async () => {
    const b = backend({ [`Top|${REGION}`]: { state: record({ reads: ['us-west-2', 'EU-WEST-1'] }) } });
    await expect(
      driftProducerRegionEvidence(
        record({ reads: ['eu-west-1'], parentStack: 'Top', parentRegion: REGION }),
        'Top~C',
        REGION,
        b
      )
    ).resolves.toEqual({ regions: ['eu-west-1', 'us-west-2'], complete: true });
  });

  it("reads the parent in the region its record names, not the child's", async () => {
    const b = backend({ [`Top|eu-central-1`]: { state: record({ reads: ['us-west-2'] }) } });
    const evidence = await driftProducerRegionEvidence(
      record({ parentStack: 'Top', parentRegion: 'eu-central-1' }),
      'Top~C',
      REGION,
      b
    );
    expect(evidence).toEqual({ regions: ['us-west-2'], complete: true });
  });

  it.each([
    ['missing', undefined],
    ['unreadable', new Error('AccessDenied')],
    ['stored under a region its body disagrees with', { state: record(), divergentBodyRegion: 'x' }],
    ['a non-object body', { state: null }],
    ['malformed reads', { state: { ...record(), outputReads: [null] } }],
  ])('a parent record that is %s makes the evidence incomplete', async (_label, entry) => {
    const b = backend({ [`Top|${REGION}`]: entry });
    const evidence = await driftProducerRegionEvidence(
      record({ reads: ['eu-west-1'], parentStack: 'Top', parentRegion: REGION }),
      'Top~C',
      REGION,
      b
    );
    expect(evidence).toEqual({ regions: ['eu-west-1'], complete: false });
  });

  it("a stack's OWN malformed reads still throw, naming its own record (the pre-#4213 behaviour)", async () => {
    await expect(
      driftProducerRegionEvidence({ ...record(), outputReads: [null] } as never, 'Top', REGION, backend({}))
    ).rejects.toThrow();
  });

  it('a record naming a parent under a key without `~` walks to that parent', async () => {
    const b = backend({ [`Top|${REGION}`]: { state: record({ reads: ['us-west-2'] }) } });
    await expect(
      driftProducerRegionEvidence(record({ parentStack: 'Top', parentRegion: REGION }), 'Child', REGION, b)
    ).resolves.toEqual({ regions: ['us-west-2'], complete: true });
  });

  it.each([
    ['a record naming a different parent than its key', 'A~Child', { parentStack: 'B' }],
    ['a non-string parentStack', 'Child', { parentStack: 7 }],
    ['a key that starts with `~`', '~Child', {}],
    ['a non-string parentRegion', 'A~Child', { parentStack: 'A', parentRegion: 7 }],
  ])('%s is incomplete, and reads no other record', async (_label, key, extra) => {
    const b = backend({
      [`A|${REGION}`]: { state: record() },
      [`B|${REGION}`]: { state: record() },
    });
    const evidence = await driftProducerRegionEvidence(
      record({ reads: ['eu-west-1'], ...(extra as Partial<StackState>) }),
      key,
      REGION,
      b
    );
    expect(evidence).toEqual({ regions: ['eu-west-1'], complete: false });
    expect(b.getState).not.toHaveBeenCalled();
  });

  it('a record naming ITSELF as parent stops at the depth bound, incomplete', async () => {
    const self = record({ parentStack: 'Loop', parentRegion: REGION });
    const b = backend({ [`Loop|${REGION}`]: { state: self } });
    const evidence = await driftProducerRegionEvidence(self, 'Loop', REGION, b);
    expect(evidence.complete).toBe(false);
    expect(b.getState.mock.calls.length).toBe(32);
  });
});

describe('refuseUnprovenDriftSecret', () => {
  it('refuses a region-less reference on incomplete evidence, with its own code', () => {
    let thrown: unknown;
    try {
      refuseUnprovenDriftSecret(`x-${NAME_EXPR}`, 'Env.PW', 'Fn', REGION, {
        regions: [],
        complete: false,
      });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string }).code).toBe('DRIFT_SECRET_REGION_UNKNOWN');
    expect((thrown as Error).message).toContain("Fn property 'Env.PW'");
    expect((thrown as Error).message).toContain('prod/db');
  });

  it('leaves the ambiguous case to the classifier (a foreign region already on record)', () => {
    expect(() =>
      refuseUnprovenDriftSecret(NAME_EXPR, 'P', 'Fn', REGION, {
        regions: ['eu-west-1'],
        complete: false,
      })
    ).not.toThrow();
  });

  it.each([
    ['complete evidence', NAME_EXPR, true],
    ['a same-region ARN', '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:1:secret:x}}', false],
    ['a foreign ARN', '{{resolve:secretsmanager:arn:aws:secretsmanager:eu-west-1:1:secret:x}}', false],
    ['a non-secret leaf', 'plain', false],
  ])('does not refuse %s', (_label, leaf, complete) => {
    expect(() =>
      refuseUnprovenDriftSecret(leaf, 'P', 'Fn', REGION, { regions: [], complete })
    ).not.toThrow();
  });

  it('refuses a leaf splicing a same-region ARN with a region-less reference', () => {
    expect(() =>
      refuseUnprovenDriftSecret(
        `{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:1:secret:x}}|${NAME_EXPR}`,
        'P',
        'Fn',
        REGION,
        { regions: [], complete: false }
      )
    ).toThrow(/prod\/db/);
  });
});
