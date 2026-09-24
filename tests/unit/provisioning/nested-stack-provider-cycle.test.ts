import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../../src/provisioning/nested-stack-context.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * Issue go-to-k/cdkd#3247: a nested template whose `aws:asset:path` resolves
 * back onto its own nesting chain must be refused BEFORE any child engine
 * runs, because here every level of the walk is a real deploy.
 *
 * The `DeployEngine` double below RECURSES, which the one in
 * `nested-stack-provider.test.ts` does not: for every nested-stack row in the
 * template it is handed, it calls `provider.create` inside the context the
 * provider switched into, exactly as the real engine reaching such a row does.
 * That is what makes "no engine was constructed" a meaningful assertion, and
 * what makes the unguarded provider actually loop in this file.
 */
const engineDeploys: string[] = [];
/** Trips the double once the unguarded recursion has clearly run away. */
const RUNAWAY_DEPTH = 12;

vi.mock('../../../src/deployment/deploy-engine.js', () => ({
  DeployEngine: vi.fn().mockImplementation(() => ({
    deploy: vi.fn(
      async (stackName: string, template: { Resources?: Record<string, { Type?: string }> }) => {
        engineDeploys.push(stackName);
        if (engineDeploys.length > RUNAWAY_DEPTH) {
          throw new Error(`runaway: ${engineDeploys.length} child engines deployed`);
        }
        const mod = await import('../../../src/provisioning/providers/nested-stack-provider.js');
        const provider = new mod.NestedStackProvider();
        for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
          if (resource?.Type !== 'AWS::CloudFormation::Stack') continue;
          await provider.create(logicalId, 'AWS::CloudFormation::Stack', {});
        }
        return { stackName, created: 1, updated: 0, deleted: 0, unchanged: 0, durationMs: 1 };
      }
    ),
  })),
  DEFAULT_RESOURCE_WARN_AFTER_MS: 5 * 60 * 1000,
  DEFAULT_RESOURCE_TIMEOUT_MS: 30 * 60 * 1000,
}));

vi.mock('../../../src/cli/commands/destroy-runner.js', () => ({
  // Reports one SKIPPED resource, so `delete()` takes its `outcome: 'skipped'`
  // arm, whose `reason` interpolates the derived child stack name.
  runDestroyForStack: vi.fn(async (stackName: string) => ({
    stackName,
    cancelled: false,
    skippedEmpty: false,
    deletedCount: 0,
    retainedCount: 0,
    skippedCount: 1,
    errorCount: 0,
    interrupted: false,
  })),
}));

/**
 * `nestedTemplates` is rebuilt onto a NULL-PROTOTYPE record so this harness
 * carries the shape production carries: `AssemblyReader.extractStackInfo` and
 * every consumer's `??` fallback build one (issue go-to-k/cdkd#3480), and on a
 * `{}` literal the `if (!childTemplatePath)` guards below answer an inherited
 * `Object.prototype` member for a logical id like `toString` and skip.
 */
function makeContext(rows: Record<string, string>): NestedStackProviderContext {
  const nestedTemplates = Object.assign(Object.create(null) as Record<string, string>, rows);
  const state: StackState = {
    version: 10,
    stackName: 'any',
    region: 'us-east-1',
    resources: {},
    outputs: {},
    lastModified: 0,
  };
  return {
    stateBackend: {
      getState: vi.fn(async () => ({ state, etag: 'etag-1' })),
    } as unknown as NestedStackProviderContext['stateBackend'],
    lockManager: {} as NestedStackProviderContext['lockManager'],
    providerRegistry: {} as NestedStackProviderContext['providerRegistry'],
    parentStackName: 'Parent',
    parentRegion: 'us-east-1',
    accountId: '123456789012',
    awsClients: {} as NestedStackProviderContext['awsClients'],
    stateBucket: 'cdkd-state-test',
    dagBuilder: {} as NestedStackProviderContext['dagBuilder'],
    diffCalculator: {} as NestedStackProviderContext['diffCalculator'],
    options: { concurrency: 1 },
    nestedTemplates,
  };
}

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-nested-provider-cycle-')));
}

function writeTemplate(dir: string, name: string, rows: Record<string, string>): string {
  const file = join(dir, name);
  const Resources: Record<string, unknown> = { Topic: { Type: 'AWS::SNS::Topic' } };
  for (const [logicalId, assetPath] of Object.entries(rows)) {
    Resources[logicalId] = {
      Type: 'AWS::CloudFormation::Stack',
      Properties: { TemplateURL: 'https://example.com/t.json' },
      Metadata: { 'aws:asset:path': assetPath },
    };
  }
  writeFileSync(file, JSON.stringify({ Resources }));
  return file;
}

async function capture(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the provider to refuse, but it resolved');
}

beforeEach(() => {
  engineDeploys.length = 0;
});

describe('NestedStackProvider — nested-template cycle (issue #3247)', () => {
  it('create() refuses a child template that names itself, before any child engine is built', async () => {
    const dir = tmp();
    const child = writeTemplate(dir, 'child.nested.template.json', {
      Loop: 'child.nested.template.json',
    });
    const provider = new NestedStackProvider();

    const err = await capture(() =>
      withNestedStackContext(makeContext({ Child: child }), () =>
        provider.create('Child', 'AWS::CloudFormation::Stack', {})
      )
    );

    expect(err.message).toContain("under stack 'Parent' contains a cycle");
    expect(err.message).toContain(`'Child' (${child}) -> 'Loop' (${child})`);
    expect(err.message).toContain('Refusing to deploy any level of it.');
    expect(isMarkedNonRetryable(err)).toBe(true);
    // The point of refusing up front: NOTHING of the cyclic tree deployed.
    expect(engineDeploys).toEqual([]);
  });

  it('create() refuses a longer cycle (A -> B -> A) at the top-most row, with no level deployed', async () => {
    const dir = tmp();
    const a = writeTemplate(dir, 'a.nested.template.json', { ToB: 'b.nested.template.json' });
    const b = writeTemplate(dir, 'b.nested.template.json', { BackToA: 'a.nested.template.json' });
    const provider = new NestedStackProvider();

    const err = await capture(() =>
      withNestedStackContext(makeContext({ Child: a }), () =>
        provider.create('Child', 'AWS::CloudFormation::Stack', {})
      )
    );

    expect(err.message).toContain(`'Child' (${a}) -> 'ToB' (${b}) -> 'BackToA' (${a})`);
    expect(engineDeploys).toEqual([]);
  });

  it('create() refuses a cycle that sits several levels down, still before the FIRST level deploys', async () => {
    // An ancestor chain threaded through the recursion would refuse this only
    // after Parent~Child and Parent~Child~Mid had been deployed.
    const dir = tmp();
    const top = writeTemplate(dir, 'top.json', { Mid: 'mid.json' });
    writeTemplate(dir, 'mid.json', { Deep: 'deep.json' });
    writeTemplate(dir, 'deep.json', { BackToMid: 'mid.json' });
    const provider = new NestedStackProvider();

    const err = await capture(() =>
      withNestedStackContext(makeContext({ Child: top }), () =>
        provider.create('Child', 'AWS::CloudFormation::Stack', {})
      )
    );

    expect(err.message).toContain('contains a cycle');
    expect(engineDeploys).toEqual([]);
  });

  it('update() refuses the same cycle, before any child engine is built', async () => {
    const dir = tmp();
    const child = writeTemplate(dir, 'child.json', { Loop: 'child.json' });
    const provider = new NestedStackProvider();

    const err = await capture(() =>
      withNestedStackContext(makeContext({ Child: child }), () =>
        provider.update(
          'Child',
          'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child',
          'AWS::CloudFormation::Stack',
          {},
          {}
        )
      )
    );

    expect(err.message).toContain('contains a cycle');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(engineDeploys).toEqual([]);
  });

  it('refuses an absolute aws:asset:path two levels down before the levels above it deploy', async () => {
    const dir = tmp();
    const top = writeTemplate(dir, 'top.json', { Mid: 'mid.json' });
    writeTemplate(dir, 'mid.json', { Escapes: '/etc/outside.json' });
    const provider = new NestedStackProvider();

    const err = await capture(() =>
      withNestedStackContext(makeContext({ Child: top }), () =>
        provider.create('Child', 'AWS::CloudFormation::Stack', {})
      )
    );

    expect(err.message).toContain("Metadata['aws:asset:path']=/etc/outside.json which is absolute");
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(engineDeploys).toEqual([]);
  });

  it('refuses a cycle spelled through an ARRAY-valued Resources, which the deploy would follow as rows 0, 1, ...', async () => {
    const dir = tmp();
    const child = join(dir, 'child.json');
    writeFileSync(
      child,
      JSON.stringify({
        Resources: [
          { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': 'child.json' } },
        ],
      })
    );
    const provider = new NestedStackProvider();

    const err = await capture(() =>
      withNestedStackContext(makeContext({ Child: child }), () =>
        provider.create('Child', 'AWS::CloudFormation::Stack', {})
      )
    );

    expect(err.message).toContain(`'Child' (${child}) -> '0' (${child})`);
    expect(engineDeploys).toEqual([]);
  });

  it('follows exactly the rows the pre-deploy walk follows (one shared row reader)', () => {
    // The guard is only a guard while both sides agree on what a row is. An
    // array-valued Resources is the shape they once disagreed on.
    const provider = new NestedStackProvider();
    const index = (
      provider as unknown as {
        indexGrandchildTemplates(t: unknown, p: string): Record<string, string>;
      }
    ).indexGrandchildTemplates.bind(provider);

    expect(
      index(
        {
          Resources: [
            { Type: 'AWS::CloudFormation::Stack', Metadata: { 'aws:asset:path': 'g.json' } },
          ],
        },
        '/out/child.json'
      )
    ).toEqual({ '0': '/out/g.json' });
  });

  it('keeps the per-level absolute-path backstop: non-retryable and display-safe', () => {
    // Unreachable through create()/update() now that the up-front walk reports
    // the same defect first, so it is driven directly.
    const provider = new NestedStackProvider();
    const index = (
      provider as unknown as {
        indexGrandchildTemplates(t: unknown, p: string): Record<string, string>;
      }
    ).indexGrandchildTemplates.bind(provider);
    const forged = `G${String.fromCharCode(0x1b)}[2KFORGED`;

    let err: Error | undefined;
    try {
      index(
        {
          Resources: {
            [forged]: {
              Type: 'AWS::CloudFormation::Stack',
              Metadata: { 'aws:asset:path': `/abs/${forged}.json` },
            },
          },
        },
        '/out/child.json'
      );
    } catch (e) {
      err = e as Error;
    }

    expect(err?.message).toContain('which is absolute');
    expect(err?.message).toContain('Refusing to load.');
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect([...err!.message].filter((ch) => ch.codePointAt(0)! < 0x20)).toEqual([]);
    expect(err!.message).toContain('FORGED');
  });

  it('follows the RAW aws:asset:path in asset-redirect mode, the same file the walk validated', async () => {
    // The asset-reference rewrite walks every string in the child template,
    // and a path segment spelling a bootstrap bucket name is rewritten like
    // any other occurrence. Indexing the grandchildren AFTER the rewrite made
    // the deploy follow <TARGET>/x.json while the walk had validated
    // <SRC>/x.json, and <TARGET>/x.json here points back at itself once
    // rewritten: a cycle the guard never saw.
    const { buildAssetRedirectMap } = await import('../../../src/assets/asset-redirect.js');
    const SRC = 'cdk-hnb659fds-assets-123456789012-us-east-1';
    const TARGET = 'cdkd-assets-123456789012-us-east-1';
    const assetRedirect = buildAssetRedirectMap(
      {
        version: '38.0.0',
        files: {
          aaaa1111: {
            displayName: 'Code',
            source: { path: 'asset.aaaa1111', packaging: 'zip' },
            destinations: {
              d1: {
                bucketName: 'cdk-hnb659fds-assets-${AWS::AccountId}-${AWS::Region}',
                objectKey: 'aaaa1111.zip',
              },
            },
          },
        },
        dockerImages: {},
      },
      {
        assetBucket: TARGET,
        containerRepo: 'cdkd-container-assets-123456789012-us-east-1',
        assetSupportVersion: 1,
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      '123456789012',
      'us-east-1'
    );
    const dir = tmp();
    mkdirSync(join(dir, SRC));
    mkdirSync(join(dir, TARGET));
    const child = writeTemplate(dir, 'child.json', { Loop: `${SRC}/x.json` });
    writeTemplate(join(dir, SRC), 'x.json', {});
    writeTemplate(join(dir, TARGET), 'x.json', { Loop: `../${SRC}/x.json` });
    const provider = new NestedStackProvider();

    await withNestedStackContext({ ...makeContext({ Child: child }), assetRedirect }, () =>
      provider.create('Child', 'AWS::CloudFormation::Stack', {})
    );

    expect(engineDeploys).toEqual(['Parent~Child', 'Parent~Child~Loop']);
  });

  it('follows a nested row named __proto__ like any other row', async () => {
    // Written as JSON text: assigning `obj['__proto__']` in JS would set the
    // prototype instead of creating the key JSON.parse creates.
    const dir = tmp();
    writeTemplate(dir, 'leaf.json', {});
    const child = join(dir, 'child.json');
    writeFileSync(
      child,
      '{"Resources":{"__proto__":{"Type":"AWS::CloudFormation::Stack","Metadata":{"aws:asset:path":"leaf.json"}}}}'
    );
    const provider = new NestedStackProvider();

    await withNestedStackContext(makeContext({ Child: child }), () =>
      provider.create('Child', 'AWS::CloudFormation::Stack', {})
    );

    expect(engineDeploys).toEqual(['Parent~Child', 'Parent~Child~__proto__']);
  });

  it.each(['__proto__', 'toString', 'constructor'])(
    'fires the not-found guard for an unindexed row named %s, rather than reading a prototype member',
    async (logicalId) => {
      // The WIRING half of issue go-to-k/cdkd#3480: the root index reaching
      // this provider is null-prototype, so a row that was never indexed reads
      // back `undefined` and `if (!childTemplatePath)` fires with the row's
      // name in it. On the `{}` literal this index used to be, the lookup
      // answered an inherited `Object.prototype` member -- truthy -- so the
      // guard was SKIPPED and the member reached `readFileSync`, surfacing as
      // `Failed to read nested template at [object Object]`.
      const provider = new NestedStackProvider();

      const err = await capture(() =>
        withNestedStackContext(makeContext({}), () =>
          provider.create(logicalId, 'AWS::CloudFormation::Stack', {})
        )
      );

      expect(err.message).toContain('Nested template file not found');
      expect(err.message).toContain(logicalId);
      expect(err.message).not.toContain('[object Object]');
    }
  );

  it('still follows an indexed row whose name collides with Object.prototype', async () => {
    const dir = tmp();
    const child = writeTemplate(dir, 'child.json', {});

    const provider = new NestedStackProvider();

    await withNestedStackContext(makeContext({ toString: child }), () =>
      provider.create('toString', 'AWS::CloudFormation::Stack', {})
    );

    expect(engineDeploys).toEqual(['Parent~toString']);
  });

  it('still deploys a diamond: two sibling rows naming one template', async () => {
    const dir = tmp();
    writeTemplate(dir, 'shared.json', {});
    const child = writeTemplate(dir, 'child.json', { Left: 'shared.json', Right: 'shared.json' });
    const provider = new NestedStackProvider();

    await withNestedStackContext(makeContext({ Child: child }), () =>
      provider.create('Child', 'AWS::CloudFormation::Stack', {})
    );

    expect(engineDeploys).toEqual(['Parent~Child', 'Parent~Child~Left', 'Parent~Child~Right']);
  });

  it('still deploys a legitimate three-level tree, one engine per level', async () => {
    const dir = tmp();
    writeTemplate(dir, 'grand.json', {});
    writeTemplate(dir, 'mid.json', { Grand: 'grand.json' });
    const child = writeTemplate(dir, 'child.json', { Mid: 'mid.json' });
    const provider = new NestedStackProvider();

    await withNestedStackContext(makeContext({ Child: child }), () =>
      provider.create('Child', 'AWS::CloudFormation::Stack', {})
    );

    expect(engineDeploys).toEqual([
      'Parent~Child',
      'Parent~Child~Mid',
      'Parent~Child~Mid~Grand',
    ]);
  });

  describe('template-controlled text in the other deploy-path throws', () => {
    const forged = `X${String.fromCharCode(0x1b)}[2K${String.fromCharCode(0x0d)}FORGED`;
    const controls = (text: string): string[] =>
      [...text].filter((ch) => ch.codePointAt(0)! < 0x20);

    it('create(): nested template path missing from the index', async () => {
      const err = await capture(() =>
        withNestedStackContext({ ...makeContext({}), parentStackName: `Parent~${forged}` }, () =>
          new NestedStackProvider().create(forged, 'AWS::CloudFormation::Stack', {})
        )
      );
      expect(err.message).toContain('Nested template file not found');
      expect(controls(err.message)).toEqual([]);
      expect(err.message.match(/FORGED/g)).toHaveLength(2);
    });

    it('update(): nested template path missing from the index', async () => {
      const err = await capture(() =>
        withNestedStackContext(makeContext({}), () =>
          new NestedStackProvider().update(forged, 'arn', 'AWS::CloudFormation::Stack', {}, {})
        )
      );
      expect(err.message).toContain('on update');
      expect(controls(err.message)).toEqual([]);
      expect(err.message).toContain('FORGED');
    });

    it('create(): a child template that cannot be parsed', async () => {
      const dir = tmp();
      const child = join(dir, 'child.json');
      // JSON.parse quotes the offending input back in its message.
      writeFileSync(child, `${forged}{`);
      const err = await capture(() =>
        withNestedStackContext(makeContext({ Child: child }), () =>
          new NestedStackProvider().create('Child', 'AWS::CloudFormation::Stack', {})
        )
      );
      expect(err.message).toContain('Failed to parse nested template');
      expect(controls(err.message)).toEqual([]);
    });

    it('create(): a child template that cannot be read', async () => {
      const dir = tmp();
      const err = await capture(() =>
        withNestedStackContext(makeContext({ Child: join(dir, `${forged}.json`) }), () =>
          new NestedStackProvider().create('Child', 'AWS::CloudFormation::Stack', {})
        )
      );
      expect(err.message).toContain('Failed to read nested template');
      expect(controls(err.message)).toEqual([]);
      expect(err.message).toContain('FORGED');
    });

    it('create(): a non-scalar child Parameter', async () => {
      const dir = tmp();
      const child = writeTemplate(dir, 'child.json', {});
      const err = await capture(() =>
        withNestedStackContext(makeContext({ Child: child }), () =>
          new NestedStackProvider().create('Child', 'AWS::CloudFormation::Stack', {
            Parameters: { [forged]: { Ref: 'Unresolved' } },
          })
        )
      );
      expect(err.message).toContain('resolved to a non-scalar value');
      expect(controls(err.message)).toEqual([]);
      expect(err.message).toContain('FORGED');
    });

    it('delete(): the skip reason naming the derived child stack', async () => {
      const result = await withNestedStackContext(makeContext({}), () =>
        new NestedStackProvider().delete(forged, 'arn', 'AWS::CloudFormation::Stack')
      );
      const reason = (result as { reason: string }).reason;
      expect(reason).toContain('skipped 1 resource(s)');
      expect(controls(reason)).toEqual([]);
      expect(reason).toContain('FORGED');
    });

    it('getAttribute(): an attribute outside the recorded Outputs map', async () => {
      const err = await capture(() =>
        new NestedStackProvider().getAttribute('arn', 'AWS::CloudFormation::Stack', forged)
      );
      expect(err.message).toContain('is not in the recorded Outputs map');
      expect(controls(err.message)).toEqual([]);
      expect(err.message).toContain('FORGED');
    });
  });

  it('renders template-controlled text display-safely in the refusal', async () => {
    const dir = tmp();
    const forged = `Loop${String.fromCharCode(0x1b)}[2K${String.fromCharCode(0x0d)}FORGED`;
    const child = writeTemplate(dir, 'child.json', { [forged]: 'child.json' });
    const provider = new NestedStackProvider();

    const err = await capture(() =>
      withNestedStackContext(makeContext({ Child: child }), () =>
        provider.create('Child', 'AWS::CloudFormation::Stack', {})
      )
    );

    const controls = [...err.message].filter((ch) => ch.codePointAt(0)! < 0x20);
    expect(controls).toEqual([]);
    expect(err.message).toContain('FORGED');
  });
});
