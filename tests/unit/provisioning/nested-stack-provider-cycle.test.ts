import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
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
  runDestroyForStack: vi.fn(),
}));

function makeContext(nestedTemplates: Record<string, string>): NestedStackProviderContext {
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

    expect(err.message).toContain("Metadata['aws:asset:path']='/etc/outside.json' which is absolute");
    expect(isMarkedNonRetryable(err)).toBe(true);
    expect(engineDeploys).toEqual([]);
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
