import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#5868: an AppSync ApiKey's physical id is `<apiId>|<apiKeyId>`,
// and the key segment IS the bearer credential. A replacement (an `ApiId`
// change) and a provider-driven replacement print the old and new ids; none
// may print the key, while the public apiId stays readable.
const logLines = vi.hoisted(() => [] as string[]);
// Each line through the sink masker the real logger applies, so a line masked
// only by a bag bound around it reads as printed.
vi.mock('../../../src/utils/logger.js', async () => {
  const { currentLogLineMasker: sink } = await import('../../../src/utils/log-line-masker.js');
  const capture = (...args: unknown[]): void => {
    const line = args.map(String).join(' ');
    logLines.push(sink()?.(line) ?? line);
  };
  const fns = {
    setLevel: vi.fn(),
    debug: capture,
    info: capture,
    warn: capture,
    error: capture,
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));
// A changed row asks CloudFormation for the type's create-only properties; a
// refusal falls back to the bundled schema (`ApiId` is create-only for both
// types here), so nothing leaves the process.
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: () => Promise.reject(new Error('DescribeType unavailable in this test')),
    })),
  };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { ccUpdateUnsupportedRejection } from '../_cc-unsupported-action.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const OLD_API = 'oldapi5868aaaa';
const NEW_API = 'newapi5868bbbb';
const OLD_KEY = 'da2-oldkey5868secretvalue1111';
const NEW_KEY = 'da2-newkey5868secretvalue2222';

function state(resourceType: string, properties: Record<string, unknown>): StackState {
  return {
    version: 15,
    stackName: 's',
    region: 'us-east-1',
    resources: {
      Key: {
        physicalId: `${OLD_API}|${OLD_KEY}`,
        resourceType,
        properties,
        attributes: { ApiKey: OLD_KEY },
        dependencies: [],
      },
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
}

function harness(
  current: StackState,
  extra: { update?: () => unknown; options?: Record<string, unknown>; levels?: string[][] } = {}
) {
  const provider = {
    create: vi.fn().mockResolvedValue({
      physicalId: `${NEW_API}|${NEW_KEY}`,
      attributes: { ApiKey: NEW_KEY },
    }),
    update: vi.fn(extra.update),
    delete: vi.fn((_logicalId: unknown, _physicalId: unknown): undefined => undefined),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
    import: vi.fn().mockResolvedValue(null),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state: current, etag: 'e0' }),
      saveState,
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn(),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn(() => extra.levels ?? [['Key']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as never,
    new DiffCalculator(),
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    } as never,
    { dryRun: false, forceStatefulRecreation: true, parameters: {}, ...extra.options },
    'us-east-1'
  );
  return { engine, provider, saveState };
}

function template(resourceType: string, properties: Record<string, unknown>): CloudFormationTemplate {
  return { Resources: { Key: { Type: resourceType, Properties: properties } } };
}

beforeEach(() => {
  logLines.length = 0;
});

const last4 = (key: string): string => `****${key.slice(-4)}`;

describe('an AppSync ApiKey replacement never logs the key (go-to-k/cdkd#5868)', () => {
  it.each([
    ['an AppSync ApiKey', 'AWS::AppSync::ApiKey', false],
    // Same id shape, a type whose id is no credential: the name segment prints.
    ['negative control, an AppSync DataSource', 'AWS::AppSync::DataSource', true],
  ])('ApiId change (delete-after-create): %s', async (_l, type, shown) => {
    const h = harness(state(type, { ApiId: OLD_API, Name: 'n' }));
    await h.engine.deploy('s', template(type, { ApiId: NEW_API, Name: 'n' }));
    const all = logLines.join('\n');
    // Premise: the replacement ran and named the old resource.
    expect(h.provider.create).toHaveBeenCalledTimes(1);
    expect(h.provider.delete).toHaveBeenCalledTimes(1);
    expect(all).toContain('Deleting old Key (');
    // The public apiId stays readable on both sides.
    expect(all).toContain(OLD_API);
    expect(all.includes(OLD_KEY)).toBe(shown);
    // The new id prints on no line of this path; never as the key either.
    expect(all).not.toContain(NEW_KEY);
    if (!shown) {
      // The display helper's rendering, not a bag's `***`.
      expect(all).toContain(`Deleting old Key (${OLD_API}|${last4(OLD_KEY)})...`);
    }
    // The persisted record keeps the full id.
    const saved = JSON.stringify(h.saveState.mock.calls.map((c) => c[2] ?? c));
    expect(saved).toContain(`${NEW_API}|${NEW_KEY}`);
  });

  it.each([
    ['an AppSync ApiKey', 'AWS::AppSync::ApiKey', false],
    ['negative control, an AppSync DataSource', 'AWS::AppSync::DataSource', true],
  ])('UpdateReplacePolicy: Retain keeps the old one: %s', async (_l, type, shown) => {
    const h = harness(state(type, { ApiId: OLD_API, Name: 'n' }));
    const tpl = template(type, { ApiId: NEW_API, Name: 'n' });
    tpl.Resources['Key']!.UpdateReplacePolicy = 'Retain';
    await h.engine.deploy('s', tpl);
    const all = logLines.join('\n');
    expect(all).toContain('Retaining old Key (');
    expect(all).toContain(OLD_API);
    expect(all.includes(OLD_KEY)).toBe(shown);
    if (!shown) {
      expect(all).toContain(`Retaining old Key (${OLD_API}|${last4(OLD_KEY)})`);
    }
  });

  it.each([
    ['an AppSync ApiKey', 'AWS::AppSync::ApiKey', false],
    ['negative control, an AppSync DataSource', 'AWS::AppSync::DataSource', true],
  ])('a provider-driven replacement ("was replaced: old -> new"): %s', async (_l, type, shown) => {
    // A mutable property changes and the provider replaces inside update().
    const h = harness(state(type, { ApiId: OLD_API, Description: 'a' }), {
      update: () => ({
        physicalId: `${NEW_API}|${NEW_KEY}`,
        wasReplaced: true,
        attributes: { ApiKey: NEW_KEY },
      }),
    });
    await h.engine.deploy('s', template(type, { ApiId: OLD_API, Description: 'b' }));
    const line = logLines.filter((l) => l.includes('was replaced:')).join('\n');
    // Premise: the provider's update ran and the line printed.
    expect(h.provider.update).toHaveBeenCalledTimes(1);
    expect(line).toContain('Resource Key was replaced:');
    expect(line).toContain(OLD_API);
    expect(line).toContain(NEW_API);
    expect(logLines.join('\n').includes(OLD_KEY)).toBe(shown);
    expect(logLines.join('\n').includes(NEW_KEY)).toBe(shown);
    if (!shown) {
      expect(line).toContain(
        `was replaced: ${OLD_API}|${last4(OLD_KEY)} -> ${NEW_API}|${last4(NEW_KEY)}`
      );
    }
  });
});

describe('the UPDATE-not-supported fallback under Retain never logs the key (go-to-k/cdkd#5868)', () => {
  it.each([
    ['an AppSync ApiKey', 'AWS::AppSync::ApiKey', false],
    ['negative control, an AppSync DataSource', 'AWS::AppSync::DataSource', true],
  ])('%s', async (_l, type, shown) => {
    const h = harness(state(type, { ApiId: OLD_API, Description: 'a' }), {
      update: () => {
        throw ccUpdateUnsupportedRejection(type, 'Key', `${OLD_API}|${OLD_KEY}`);
      },
    });
    const tpl = template(type, { ApiId: OLD_API, Description: 'b' });
    tpl.Resources['Key']!.UpdateReplacePolicy = 'Retain';
    await h.engine.deploy('s', tpl).catch(() => undefined);
    const all = logLines.join('\n');
    // Premise: the fallback created the new one and kept the old one.
    expect(h.provider.create).toHaveBeenCalledTimes(1);
    expect(h.provider.delete).not.toHaveBeenCalled();
    expect(all).toContain('is RETAINED and is no longer');
    expect(all).toContain(OLD_API);
    expect(all.includes(OLD_KEY)).toBe(shown);
    if (!shown) {
      expect(all).toContain(`resource (${OLD_API}|${last4(OLD_KEY)}) is RETAINED`);
      // The row's partial reason, which also lands in the durable event store.
      expect(all).toContain(`(${OLD_API}|${last4(OLD_KEY)}), now untracked by cdkd`);
    }
  });
});

describe('the in-process rollback of an ApiKey replacement never logs a key (go-to-k/cdkd#5868)', () => {
  it.each([
    ['an AppSync ApiKey', 'AWS::AppSync::ApiKey', false],
    ['negative control, an AppSync DataSource', 'AWS::AppSync::DataSource', true],
  ])('%s', async (_l, type, shown) => {
    const RECREATED_KEY = 'da2-recreated5868secretvalue3333';
    // Level 1 replaces the key; level 2's create fails, so the deploy rolls
    // the replacement back: the new key is deleted, the old one re-created.
    const h = harness(state(type, { ApiId: OLD_API, Name: 'n' }), {
      levels: [['Key'], ['Boom']],
    });
    let creates = 0;
    h.provider.create.mockImplementation(async (logicalId: string) => {
      if (logicalId === 'Boom') throw new Error('Boom create failed');
      creates++;
      return creates === 1
        ? { physicalId: `${NEW_API}|${NEW_KEY}`, attributes: { ApiKey: NEW_KEY } }
        : { physicalId: `${OLD_API}|${RECREATED_KEY}`, attributes: { ApiKey: RECREATED_KEY } };
    });
    // The rollback's delete of the NEW key fails, so its survivor warning
    // names the new id.
    h.provider.delete.mockImplementation((_logicalId: unknown, physicalId: unknown) => {
      if (physicalId === `${NEW_API}|${NEW_KEY}`) throw new Error('AccessDenied on delete');
      return undefined;
    });
    const tpl = template(type, { ApiId: NEW_API, Name: 'n' });
    tpl.Resources['Boom'] = { Type: 'AWS::SNS::Topic', Properties: {} };
    await h.engine.deploy('s', tpl).catch(() => undefined);
    const all = logLines.join('\n');
    // Premise: the rollback reversed the replacement, failed to delete the new
    // key, and named both sides.
    expect(all).toContain('Rollback: Key replacement reversed (old resource re-created as');
    expect(all).toContain(`Deleting old Key (${OLD_API}|`);
    expect(all).toContain(NEW_API);
    expect(all.includes(OLD_KEY)).toBe(shown);
    expect(all.includes(RECREATED_KEY)).toBe(shown);
    expect(all.includes(NEW_KEY)).toBe(shown);
    if (!shown) {
      expect(all).toContain(`re-created as ${OLD_API}|${last4(RECREATED_KEY)})`);
    }
  });
});

describe('a Type change away from an ApiKey never logs its key (go-to-k/cdkd#5868)', () => {
  it.each([
    ['an AppSync ApiKey', 'AWS::AppSync::ApiKey', false],
    ['negative control, an AppSync DataSource', 'AWS::AppSync::DataSource', true],
  ])(
    '--recreate-via-sdk-provider onto a NAMED type deletes the old one create-first: %s',
    async (_l, type, shown) => {
      const h = harness(state(type, { ApiId: OLD_API, Name: 'n' }), {
        options: {
          recreateTargets: {
            stackName: 's',
            viaCcApi: new Set<string>(),
            viaSdkProvider: new Set<string>(['Key']),
          },
        },
      });
      h.provider.create.mockResolvedValue({ physicalId: 'q-new-5868', attributes: {} });
      await h.engine.deploy('s', template('AWS::SQS::Queue', { QueueName: 'q-new-5868' }));
      const all = logLines.join('\n');
      // Premise: the create-first arm ran (create, then the old delete).
      expect(h.provider.create).toHaveBeenCalledTimes(1);
      expect(h.provider.delete).toHaveBeenCalledTimes(1);
      expect(all).toContain('Deleting old Key (');
      expect(all).toContain(OLD_API);
      expect(all.includes(OLD_KEY)).toBe(shown);
      if (!shown) {
        expect(all).toContain(`Deleting old Key (${OLD_API}|${last4(OLD_KEY)})...`);
      }
    }
  );

  it.each([
    ['an AppSync ApiKey', 'AWS::AppSync::ApiKey', false],
    ['negative control, an AppSync DataSource', 'AWS::AppSync::DataSource', true],
  ])('its rollback re-creates the old ApiKey under the OLD type: %s', async (_l, type, shown) => {
    const RECREATED_KEY = 'da2-typechange5868secretvalue4444';
    const h = harness(state(type, { ApiId: OLD_API, Name: 'n' }), {
      levels: [['Key'], ['Boom']],
      options: {
        recreateTargets: {
          stackName: 's',
          viaCcApi: new Set<string>(),
          viaSdkProvider: new Set<string>(['Key']),
        },
      },
    });
    h.provider.create.mockImplementation(async (logicalId: string, resourceType: string) => {
      if (logicalId === 'Boom') throw new Error('Boom create failed');
      return resourceType === 'AWS::SQS::Queue'
        ? { physicalId: 'q-new-5868', attributes: {} }
        : { physicalId: `${OLD_API}|${RECREATED_KEY}`, attributes: { ApiKey: RECREATED_KEY } };
    });
    const tpl = template('AWS::SQS::Queue', { QueueName: 'q-new-5868' });
    tpl.Resources['Boom'] = { Type: 'AWS::SNS::Topic', Properties: {} };
    await h.engine.deploy('s', tpl).catch(() => undefined);
    const all = logLines.join('\n');
    // Premise: the rollback re-created the old resource across the Type change.
    expect(all).toContain('Rollback: Key replacement reversed (old resource re-created as');
    expect(all.includes(RECREATED_KEY)).toBe(shown);
    expect(all.includes(OLD_KEY)).toBe(shown);
    if (!shown) {
      expect(all).toContain(`re-created as ${OLD_API}|${last4(RECREATED_KEY)})`);
    }
  });
});
