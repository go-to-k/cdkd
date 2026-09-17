/**
 * `state.imports[]` / `state.outputReads[]` carry TEMPLATE-DERIVED names, and
 * nothing redacted them (issue
 * [#3289](https://github.com/go-to-k/cdkd/issues/3289)). A reference whose name
 * an `Fn::Sub` assembled around a resolved secret persisted that secret in
 * plaintext in `state.json`, durably — the two lists rode
 * `redactStateForPersist`'s `...state` spread untouched.
 *
 * THESE CASES CALL THE ENGINE'S OWN METHOD. They do not re-spell the redaction
 * and assert against the re-spelling: a fence holding its own copy of the
 * subject is satisfied by itself, which is the defect
 * go-to-k/cdkd#3296 spent two review rounds on one file over. The private
 * members are reached through a cast, which is the price of testing the real
 * thing, and the alternative — driving a whole deploy — would put a mocked
 * provider registry, DAG and lock manager between the assertion and the
 * behaviour it is about.
 *
 * WHICH FIELDS, and why it is not symmetric. The issue as filed named
 * `imports[].sourceStack` / `sourceRegion`; `recordImport` takes those from the
 * exports index entry or the state scan — the PRODUCER's own record — so they
 * are not template-derived and do not leak. What leaks is
 * `imports[].exportName`, and on the other list BOTH `outputReads[].outputName`
 * and `outputReads[].sourceStack`. `sourceRegion` is template-derived but
 * passes `isClientSafeRegion` before it can be recorded and is read
 * structurally, so it is deliberately left alone — asserted below, because
 * "we left it alone" is a decision a later widening would silently reverse.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { StackState } from '../../../src/types/state.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

const SECRET_EXPR = '{{resolve:secretsmanager:prod/db:SecretString:password::}}';
const SECRET_PLAINTEXT = 'correct-horse-battery-staple';

function makeEngine(): DeployEngine {
  return new DeployEngine(
    { saveState: vi.fn(), getState: vi.fn(), listStacks: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { dryRun: false },
    'us-east-1'
  );
}

/**
 * Seed the bag the redaction reads. `perResourceSecrets` is the per-logical-id
 * store a resource's own resolution populates; the outputs pass has its own.
 * Both are private, and both are seeded here because the union of them is
 * exactly what `allRecordedSecrets` is for — a cross-stack entry carries no
 * logical id, so it has nothing to be scoped by.
 */
function seedSecrets(
  engine: DeployEngine,
  where: 'resource' | 'outputs',
  pairs: RecordedSecretValues
): void {
  const priv = engine as unknown as {
    perResourceSecrets: Map<string, RecordedSecretValues>;
    outputSecrets: RecordedSecretValues;
  };
  if (where === 'resource') priv.perResourceSecrets.set('SomeResource', pairs);
  else priv.outputSecrets = pairs;
}

function redact(engine: DeployEngine, state: StackState): StackState {
  return (
    engine as unknown as { redactStateForPersist(s: StackState): StackState }
  ).redactStateForPersist(state);
}

function baseState(overrides: Partial<StackState>): StackState {
  return {
    version: 10,
    stackName: 'Consumer',
    region: 'us-east-1',
    resources: {},
    outputs: {},
    lastModified: 0,
    ...overrides,
  } as StackState;
}

describe('cross-stack read names are redacted at persist (#3289)', () => {
  it('rewrites an `Fn::Sub`-assembled outputReads name back to its expression', () => {
    const engine = makeEngine();
    seedSecrets(engine, 'resource', new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]));

    const persisted = redact(
      engine,
      baseState({
        outputReads: [
          {
            sourceStack: `prod-${SECRET_PLAINTEXT}`,
            sourceRegion: 'us-west-2',
            outputName: `Endpoint-${SECRET_PLAINTEXT}`,
          },
        ],
      })
    );

    const entry = persisted.outputReads![0]!;
    expect(entry.sourceStack).not.toContain(SECRET_PLAINTEXT);
    expect(entry.outputName).not.toContain(SECRET_PLAINTEXT);
    expect(entry.sourceStack).toBe(`prod-${SECRET_EXPR}`);
    expect(entry.outputName).toBe(`Endpoint-${SECRET_EXPR}`);
    // Left alone on purpose: read structurally by
    // `producerRegionsFromState`, and gate-constrained before it is recorded.
    expect(entry.sourceRegion).toBe('us-west-2');
  });

  it('rewrites an imports exportName but NOT its producer coordinates', () => {
    const engine = makeEngine();
    seedSecrets(engine, 'resource', new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]));

    // The producer coordinates carry the same characters on purpose: they come
    // from the producer's own record, so even a coincidence must not rewrite
    // them, or the destroy-blocking match in `scanActiveConsumers` breaks on a
    // stack whose NAME happens to contain a secret another stack resolved.
    const persisted = redact(
      engine,
      baseState({
        imports: [
          {
            sourceStack: SECRET_PLAINTEXT,
            sourceRegion: 'eu-west-1',
            exportName: `Export-${SECRET_PLAINTEXT}`,
          },
        ],
      })
    );

    const entry = persisted.imports![0]!;
    expect(entry.exportName).toBe(`Export-${SECRET_EXPR}`);
    expect(entry.sourceStack).toBe(SECRET_PLAINTEXT);
    expect(entry.sourceRegion).toBe('eu-west-1');
  });

  it('reads the OUTPUTS pass bag too, not only the per-resource one', () => {
    // A `Fn::GetStackOutput` can sit in a `CfnOutput`'s Value, where the
    // secret is recorded in `outputSecrets` and NOT under any logical id.
    // Scoping the needles to `perResourceSecrets` alone leaves that leak open
    // and every assertion above still passes.
    const engine = makeEngine();
    seedSecrets(engine, 'outputs', new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]));

    const persisted = redact(
      engine,
      baseState({
        outputReads: [
          { sourceStack: 'Producer', sourceRegion: 'us-east-1', outputName: SECRET_PLAINTEXT },
        ],
      })
    );

    expect(persisted.outputReads![0]!.outputName).toBe(SECRET_EXPR);
  });

  it('returns the lists unchanged when this deploy resolved no secret', () => {
    const engine = makeEngine();
    const imports = [{ sourceStack: 'P', sourceRegion: 'us-east-1', exportName: 'E' }];
    const outputReads = [{ sourceStack: 'P', sourceRegion: 'us-east-1', outputName: 'O' }];

    const persisted = redact(makeEngine(), baseState({ imports, outputReads }));
    expect(persisted.imports).toEqual(imports);
    expect(persisted.outputReads).toEqual(outputReads);
    void engine;
  });

  it('leaves an absent list ABSENT rather than minting an empty one', () => {
    // `imports` is optional and its PRESENCE is meaningful: `destroy-runner`
    // strips both fields deliberately, and a record that gained `imports: []`
    // from a redaction pass would read as "this stack imports nothing" where it
    // previously read as "this record predates the field".
    const engine = makeEngine();
    seedSecrets(engine, 'resource', new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]));

    const persisted = redact(engine, baseState({}));
    expect('imports' in persisted).toBe(false);
    expect('outputReads' in persisted).toBe(false);
  });
});
