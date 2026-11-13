/**
 * go-to-k/cdkd#6146: `cdkd diff` reads a record's NoEcho value MACs through
 * `computeStackDiff`, as the deploy compares them: a property whose recorded
 * MAC differs from today's value is shown changed, an equal one is not, and a
 * stack whose records carry no MAC makes no KMS call. Run through the real
 * `computeStackDiff` with a KMS double computing a real HMAC.
 */

import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const logs = vi.hoisted(() => [] as string[]);
const kms = vi.hoisted(() => ({
  constructed: 0,
  calls: 0,
  fail: undefined as string | undefined,
  writeOnlyLookups: 0,
  secret: 'kms-hmac-key-6146-diff',
  keyArn: 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555',
}));

vi.mock('../../../src/utils/logger.js', () => {
  const at =
    (level: string) =>
    (message: unknown): void => {
      logs.push(`${level} ${String(message)}`);
    };
  const fns = {
    setLevel: vi.fn(),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  const { createHmac: hmac } = await import('node:crypto');
  class FakeKMSClient {
    constructor(_config?: unknown) {
      kms.constructed++;
    }
    async send(command: { input: { Message: Uint8Array } }): Promise<unknown> {
      kms.calls++;
      if (kms.fail !== undefined) throw Object.assign(new Error('denied'), { name: kms.fail });
      return {
        KeyId: kms.keyArn,
        Mac: new Uint8Array(hmac('sha256', kms.secret).update(command.input.Message).digest()),
      };
    }
    destroy(): void {}
  }
  return { ...actual, KMSClient: FakeKMSClient };
});

vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: async () => {
        throw Object.assign(new Error('not in this test'), { name: 'TypeNotFoundException' });
      },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
      destroy: vi.fn(),
    })),
  };
});

// `Value` stands in for a write-only property here (the deploy and the diff
// let a MAC decide only a key AWS does not report); any other lookup fails.
vi.mock('../../../src/provisioning/write-only-properties.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/provisioning/write-only-properties.js')>();
  return {
    ...actual,
    tryGetTopLevelWriteOnlyProperties: async (type: string) => {
      kms.writeOnlyLookups++;
      return type === 'AWS::SSM::Parameter' ? new Set(['Value']) : undefined;
    },
  };
});

import { computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { previewNoEchoMacChanges } from '../../../src/cli/commands/diff-recursive/noecho-macs.js';
import type { ResourceChange } from '../../../src/types/state.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import { maskedPropertyFingerprint } from '../../../src/deployment/masked-property-fingerprints.js';
import {
  formatNoEchoMac,
  noEchoMacBinding,
  noEchoMacMessage,
} from '../../../src/deployment/noecho-value-macs.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const OLD = 'old-noecho-diff-6146';
const NEW = 'new-noecho-diff-6146';
const VALUE_TEMPLATE = { Ref: 'Token' };

const backend = {
  getState: async () => null,
  saveState: vi.fn(),
  putState: vi.fn(),
  deleteState: vi.fn(),
} as unknown as S3StateBackend;

const template = (value: string): CloudFormationTemplate =>
  ({
    Parameters: { Token: { Type: 'String', NoEcho: true, Default: value } },
    Resources: {
      R: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Name: '/p/r', Type: 'String', Value: VALUE_TEMPLATE },
      },
    },
  }) as unknown as CloudFormationTemplate;

function macOf(value: string): string {
  const message = noEchoMacMessage(noEchoMacBinding(undefined, 'S', 'us-east-1'), 'Token', value)!;
  return formatNoEchoMac({
    keyArn: kms.keyArn,
    mac: createHmac('sha256', kms.secret).update(message).digest(),
  });
}

function stateOf(macs?: Record<string, string>): StackState {
  return {
    stackName: 'S',
    region: 'us-east-1',
    version: 16,
    lastModified: 0,
    outputs: {},
    resources: {
      R: {
        physicalId: '/p/r',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/p/r', Type: 'String', Value: '***' },
        attributes: {},
        dependencies: [],
        noEchoLeaves: [['Value']],
        maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(VALUE_TEMPLATE) },
        ...(macs !== undefined && { noEchoValueMacs: { Value: macs } }),
      },
    },
  } as StackState;
}

async function diffOf(state: StackState, value: string) {
  resetAccountInfoCache();
  return computeStackDiff(state, template(value), 'us-east-1', 'S', backend, new DiffCalculator());
}

beforeEach(() => {
  logs.length = 0;
  kms.constructed = 0;
  kms.calls = 0;
  kms.fail = undefined;
});

describe('cdkd diff reads NoEcho value MACs through computeStackDiff (go-to-k/cdkd#6146)', () => {
  it('a differing MAC shows the property changed, with one note naming it and neither the value nor the MAC', async () => {
    const result = await diffOf(stateOf({ Token: macOf(OLD) }), NEW);
    const change = result.changes.get('R');
    expect(change?.changeType).toBe('UPDATE');
    expect(change?.propertyChanges?.map((pc) => pc.path)).toEqual(['Value']);
    const notes = logs.filter((l) => l.includes('read a NoEcho parameter whose value changed'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('R.Value');
    expect(kms.calls).toBe(1);
    const shown = JSON.stringify([...result.changes.values()]) + logs.join('\n');
    for (const needle of [OLD, NEW, macOf(OLD).split(':').pop()!, macOf(NEW).split(':').pop()!]) {
      expect(shown).not.toContain(needle);
    }
  });

  it('an equal MAC shows no change', async () => {
    const result = await diffOf(stateOf({ Token: macOf(OLD) }), OLD);
    expect(result.changes.get('R')?.changeType).toBe('NO_CHANGE');
    expect(logs.some((l) => l.includes('read a NoEcho parameter whose value changed'))).toBe(false);
    expect(kms.calls).toBe(1);
  });

  it('a differing MAC says nothing for a key whose template text moved since, nor for a create-only key', async () => {
    const moved = stateOf({ Token: macOf(OLD) });
    moved.resources['R']!.maskedPropertyFingerprints = { Value: maskedPropertyFingerprint({ Ref: 'Other' }) };
    await diffOf(moved, NEW);
    expect(logs.some((l) => l.includes('read a NoEcho parameter whose value changed'))).toBe(false);

    logs.length = 0;
    const createOnly = stateOf();
    const record = createOnly.resources['R']!;
    record.properties = { Name: '***', Type: 'String', Value: 'v' };
    record.noEchoLeaves = [['Name']];
    record.maskedPropertyFingerprints = { Name: maskedPropertyFingerprint(VALUE_TEMPLATE) };
    record.noEchoValueMacs = { Name: { Token: macOf(OLD) } };
    resetAccountInfoCache();
    await computeStackDiff(
      createOnly,
      {
        Parameters: { Token: { Type: 'String', NoEcho: true, Default: NEW } },
        Resources: {
          R: { Type: 'AWS::SSM::Parameter', Properties: { Name: VALUE_TEMPLATE, Type: 'String', Value: 'v' } },
        },
      } as unknown as CloudFormationTemplate,
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );
    expect(logs.some((l) => l.includes('read a NoEcho parameter whose value changed'))).toBe(false);
  });

  it("a diff role without kms:GenerateMac logs at debug in the preview's words, never the deploy's advice", async () => {
    kms.fail = 'AccessDeniedException';
    const result = await diffOf(stateOf({ Token: macOf(OLD) }), NEW);
    expect(result.changes.get('R')?.changeType).toBe('NO_CHANGE');
    const lines = logs.filter((l) => l.includes('NoEcho value MACs'));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith('debug cdkd diff:')).toBe(true);
    expect(lines[0]).toContain('AccessDeniedException');
    expect(logs.some((l) => l.includes('re-sent on every deploy') || l.includes('Grant the deploying'))).toBe(false);
  });

  it('a shared cache (cdkd refactor) makes the MACs once per stack across diffs', async () => {
    const noEchoMacCache = new Map();
    for (let i = 0; i < 3; i++) {
      resetAccountInfoCache();
      const result = await computeStackDiff(stateOf({ Token: macOf(OLD) }), template(NEW), 'us-east-1', 'S', backend, new DiffCalculator(), { noEchoMacCache });
      expect(result.changes.get('R')?.changeType).toBe('UPDATE');
    }
    expect(kms.calls).toBe(1);
  });

  it('a shared write-only lookup map (cdkd refactor) asks DescribeType once per type across diffs', async () => {
    kms.writeOnlyLookups = 0;
    const macWriteOnlyLookups = new Map();
    for (let i = 0; i < 3; i++) {
      resetAccountInfoCache();
      await computeStackDiff(stateOf({ Token: macOf(OLD) }), template(NEW), 'us-east-1', 'S', backend, new DiffCalculator(), { macWriteOnlyLookups });
    }
    expect(kms.writeOnlyLookups).toBe(1);
    // Without it, each diff asks again.
    kms.writeOnlyLookups = 0;
    for (let i = 0; i < 2; i++) {
      resetAccountInfoCache();
      await computeStackDiff(stateOf({ Token: macOf(OLD) }), template(NEW), 'us-east-1', 'S', backend, new DiffCalculator());
    }
    expect(kms.writeOnlyLookups).toBe(2);
  });

  it('claims nothing for an unsettled key, nor for one that also reads another parameter', async () => {
    const unsettled = stateOf({ Token: macOf(OLD) });
    unsettled.resources['R']!.unsettledProperties = ['Value'];
    await diffOf(unsettled, NEW);
    expect(logs.some((l) => l.includes('read a NoEcho parameter whose value changed'))).toBe(false);

    logs.length = 0;
    const MIXED = { 'Fn::Sub': '${Token}-${Plain}' };
    const mixed = stateOf({ Token: macOf(OLD) });
    mixed.resources['R']!.maskedPropertyFingerprints = { Value: maskedPropertyFingerprint(MIXED) };
    resetAccountInfoCache();
    await computeStackDiff(
      mixed,
      {
        Parameters: {
          Token: { Type: 'String', NoEcho: true, Default: NEW },
          Plain: { Type: 'String', Default: 'p' },
        },
        Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: { Name: '/p/r', Type: 'String', Value: MIXED } } },
      } as unknown as CloudFormationTemplate,
      'us-east-1',
      'S',
      backend,
      new DiffCalculator()
    );
    expect(logs.some((l) => l.includes('read a NoEcho parameter whose value changed'))).toBe(false);
  });

  it('the unsettled guard on its own: a NO_CHANGE row whose record is unsettled is not claimed', async () => {
    const preview = async (unsettled: boolean) => {
      const state = stateOf({ Token: macOf(OLD) });
      if (unsettled) state.resources['R']!.unsettledProperties = ['Value'];
      const changes = new Map<string, ResourceChange>([
        ['R', { logicalId: 'R', resourceType: 'AWS::SSM::Parameter', changeType: 'NO_CHANGE' } as ResourceChange],
      ]);
      return previewNoEchoMacChanges({
        changes,
        template: template(NEW),
        resources: state.resources,
        parameterValues: { Token: NEW },
        sources: { parameters: new Set(['Token']) },
        nestedChild: false,
        stackName: 'S',
        region: 'us-east-1',
        stackInstanceId: undefined,
        logger: { debug: () => undefined, info: () => undefined },
      });
    };
    expect(await preview(false)).toEqual(['R.Value']);
    expect(await preview(true)).toEqual([]);
  });

  it('records with no MAC: no KMS client, no call, and the preview it had', async () => {
    const result = await diffOf(stateOf(), NEW);
    expect(kms.constructed).toBe(0);
    expect(kms.calls).toBe(0);
    expect(result.changes.get('R')?.changeType).toBe('NO_CHANGE');
  });
});
