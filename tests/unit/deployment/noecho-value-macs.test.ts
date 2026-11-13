/**
 * go-to-k/cdkd#6146: the NoEcho value MAC module on its own — message
 * layout, the persisted spelling, the verdict, the per-run service (call
 * counts, failures, logging) and the save's stamp.
 */
import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import {
  createNoEchoValueMacs,
  formatNoEchoMac,
  noEchoMacBinding,
  noEchoMacMessage,
  noEchoMacVerdict,
  noEchoValueMacsOf,
  NoEchoValueMacs,
  parseNoEchoMac,
  withNoEchoValueMacs,
  type NoEchoMac,
  type NoEchoMacClient,
} from '../../../src/deployment/noecho-value-macs.js';
import { markWrittenFromDeployedTemplate } from '../../../src/deployment/masked-property-fingerprints.js';
import { setAwsEndpointOverrideSource } from '../../../src/utils/aws-client-defaults.js';

const writeOnlyLookups = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../../src/provisioning/write-only-properties.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/provisioning/write-only-properties.js')>();
  return {
    ...actual,
    // A DescribeType-denied account: every lookup fails after a delay.
    tryGetTopLevelWriteOnlyProperties: async () => {
      writeOnlyLookups.calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return undefined;
    },
  };
});
import type { ResourceState } from '../../../src/types/state.js';

const ARN = 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555';
const OTHER_ARN = 'arn:aws:kms:us-east-1:123456789012:key/99999999-2222-3333-4444-555555555555';
const SECRET = 'plain-secret-value-6146';

const mac = (byte: number, keyArn = ARN): NoEchoMac => ({ keyArn, mac: Buffer.alloc(32, byte) });

afterEach(() => setAwsEndpointOverrideSource(undefined));

describe('noEchoMacMessage', () => {
  it('is domain-separated and bound to the stack and the parameter', () => {
    const a = noEchoMacMessage('instance\0id-1', 'P', 'v')!;
    expect(a.toString('utf8')).toBe('cdkd-noecho-mac/v1\0instance\0id-1\0P\0s\0v');
    expect(noEchoMacMessage('instance\0id-2', 'P', 'v')!.equals(a)).toBe(false);
    expect(noEchoMacMessage('instance\0id-1', 'Q', 'v')!.equals(a)).toBe(false);
  });

  it('is type-tagged: a list never collides with a string equal to its JSON text', () => {
    const list = noEchoMacMessage('b', 'P', ['a', 'b'])!;
    expect(list.toString('utf8')).toBe('cdkd-noecho-mac/v1\0b\0P\0j\0["a","b"]');
    expect(noEchoMacMessage('b', 'P', '["a","b"]')!.equals(list)).toBe(false);
  });

  it('refuses a message over the 4096-byte GenerateMac limit', () => {
    expect(noEchoMacMessage('b', 'P', 'x'.repeat(5000))).toBeUndefined();
  });

  it('binds a legacy stack by name and region, an instance stack by its id', () => {
    expect(noEchoMacBinding(undefined, 's', 'us-east-1')).toBe('legacy\0s\0us-east-1');
    expect(noEchoMacBinding('i-1', 's', 'us-east-1')).toBe('instance\0i-1');
  });
});

describe('the persisted spelling', () => {
  it('round-trips, and anything malformed reads as no MAC', () => {
    const text = formatNoEchoMac(mac(7));
    expect(text.startsWith(`kms-hmac-sha256:${ARN}:`)).toBe(true);
    expect(parseNoEchoMac(text)?.mac.equals(Buffer.alloc(32, 7))).toBe(true);
    for (const bad of [undefined, 5, '', 'sha256:x', 'kms-hmac-sha256:nokey', `kms-hmac-sha256:${ARN}:!!`]) {
      expect(parseNoEchoMac(bad)).toBeUndefined();
    }
  });

  it('reads a record tolerantly', () => {
    expect(noEchoValueMacsOf({ noEchoValueMacs: 'x' }).size).toBe(0);
    const read = noEchoValueMacsOf({ noEchoValueMacs: { A: { P: 'm', Q: 3 }, B: [] } });
    expect([...read.keys()]).toEqual(['A']);
    expect([...read.get('A')!.keys()]).toEqual(['P']);
  });
});

describe('noEchoMacVerdict', () => {
  const recorded = (m: NoEchoMac) => new Map([['P', formatNoEchoMac(m)]]);
  it('confirmed / changed / none', () => {
    expect(noEchoMacVerdict(recorded(mac(1)), ['P'], new Map([['P', mac(1)]]))).toBe('confirmed');
    expect(noEchoMacVerdict(recorded(mac(1)), ['P'], new Map([['P', mac(2)]]))).toBe('changed');
    // Another key: no verdict (a key change re-sends once).
    expect(noEchoMacVerdict(recorded(mac(1, OTHER_ARN)), ['P'], new Map([['P', mac(1)]]))).toBe('none');
    expect(noEchoMacVerdict(recorded(mac(1)), ['P'], undefined)).toBe('none');
    expect(noEchoMacVerdict(undefined, ['P'], new Map([['P', mac(1)]]))).toBe('none');
    // A parameter set that moved: no verdict.
    expect(noEchoMacVerdict(recorded(mac(1)), ['P', 'Q'], new Map([['P', mac(1)], ['Q', mac(1)]]))).toBe(
      'none'
    );
    expect(noEchoMacVerdict(recorded(mac(1)), [], new Map([['P', mac(1)]]))).toBe('none');
  });
});

function fakeClient(opts: { fail?: { name: string; message: string } } = {}) {
  const calls: Array<{ KeyId: string; Message: Uint8Array }> = [];
  let built = 0;
  const factory = (): NoEchoMacClient => {
    built++;
    return {
      send: async (command) => {
        const input = (command as unknown as { input: { KeyId: string; Message: Uint8Array } }).input;
        calls.push(input);
        if (opts.fail) throw Object.assign(new Error(opts.fail.message), { name: opts.fail.name });
        return { KeyId: ARN, Mac: new Uint8Array(createHmac('sha256', 'k').update(input.Message).digest()) };
      },
      destroy: () => undefined,
    };
  };
  return { factory, calls, built: () => built };
}

describe('NoEchoValueMacs', () => {
  const logger = () => ({ debug: vi.fn(), info: vi.fn() });

  it('makes one GenerateMac per parameter, the first by alias and the rest by ARN, memoized', async () => {
    const client = fakeClient();
    const service = new NoEchoValueMacs({
      region: 'us-east-1',
      binding: () => 'b',
      values: { A: 'a', B: 'b', C: 'c' },
      parameters: new Set(['A', 'B', 'C']),
      logger: logger(),
      client: client.factory,
    });
    expect(service.settled()).toBeUndefined();
    const macs = await service.macs();
    await service.macs();
    expect(macs?.size).toBe(3);
    expect(service.settled()).toBe(macs);
    expect(client.built()).toBe(1);
    expect(client.calls.map((c) => c.KeyId)).toEqual(['alias/cdkd-noecho-mac', ARN, ARN]);
  });

  it('builds no client for a stack with no NoEcho parameter', async () => {
    const client = fakeClient();
    expect(
      createNoEchoValueMacs({
        template: { Parameters: { P: { Type: 'String' } } },
        parameterValues: { P: 'x' },
        stackName: 's',
        region: 'us-east-1',
        stackInstanceId: () => undefined,
        logger: logger(),
        client: client.factory,
      })
    ).toBeUndefined();
    expect(client.built()).toBe(0);
  });

  it('makes nothing against an AWS Emulator target', async () => {
    setAwsEndpointOverrideSource(() => ({ endpoint: 'http://localhost:4566' }) as never);
    const client = fakeClient();
    const log = logger();
    const service = new NoEchoValueMacs({
      region: 'us-east-1',
      binding: () => 'b',
      values: { A: SECRET },
      parameters: new Set(['A']),
      logger: log,
      client: client.factory,
    });
    expect(await service.macs()).toBeUndefined();
    expect(client.built()).toBe(0);
    expect(log.debug).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['NotFoundException', 'debug'],
    ['AccessDeniedException', 'info'],
  ] as const)('%s: no MACs, one %s line naming only the error, never the value', async (name, level) => {
    const client = fakeClient({ fail: { name, message: `kmsmsg-6146 ${SECRET}` } });
    const log = logger();
    const service = new NoEchoValueMacs({
      region: 'us-east-1',
      binding: () => 'b',
      values: { A: SECRET, B: 'other-value' },
      parameters: new Set(['A', 'B']),
      logger: log,
      client: client.factory,
    });
    expect(await service.macs()).toBeUndefined();
    expect(client.calls).toHaveLength(1);
    const lines = [...log.debug.mock.calls, ...log.info.mock.calls].map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(log[level]).toHaveBeenCalledTimes(1);
    expect(lines[0]).not.toContain(SECRET);
    expect(lines[0]).not.toContain("kmsmsg-6146");
    if (name !== 'NotFoundException') expect(lines[0]).toContain(name);
  });

  it('a KMS call outliving the timeout is no MAC, logged as TimeoutError without the value', async () => {
    vi.useFakeTimers();
    try {
      const log = logger();
      const service = new NoEchoValueMacs({
        region: 'us-east-1',
        binding: () => 'b',
        values: { A: SECRET },
        parameters: new Set(['A']),
        logger: log,
        client: () => ({
          send: (_c, options) =>
            new Promise((_resolve, reject) => {
              options?.abortSignal?.addEventListener('abort', () =>
                reject(Object.assign(new Error(`aborted ${SECRET}`), { name: 'AbortError' }))
              );
            }),
          destroy: () => undefined,
        }),
      });
      const pending = service.macs();
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pending).toBeUndefined();
      const line = String(log.info.mock.calls[0]?.[0]);
      expect(line).toContain('(TimeoutError from');
      expect(line).not.toContain(SECRET);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a later call answering another key, or failing, drops only that parameter', async () => {
    const answers = (second: 'other-key' | 'throw'): (() => NoEchoMacClient) => () => {
      let n = 0;
      return {
        send: async (command) => {
          const input = (command as unknown as { input: { Message: Uint8Array } }).input;
          const mac = new Uint8Array(createHmac('sha256', 'k').update(input.Message).digest());
          if (n++ === 0) return { KeyId: ARN, Mac: mac };
          if (second === 'throw') throw Object.assign(new Error('x'), { name: 'ThrottlingException' });
          return { KeyId: OTHER_ARN, Mac: mac };
        },
        destroy: () => undefined,
      };
    };
    const make = (second: 'other-key' | 'throw') =>
      new NoEchoValueMacs({
        region: 'us-east-1',
        binding: () => 'b',
        values: { A: 'a', B: 'b' },
        parameters: new Set(['A', 'B']),
        logger: logger(),
        client: answers(second),
      }).macs();
    expect([...((await make('other-key')) ?? new Map()).keys()]).toEqual(['A']);
    // A later parameter's throttle costs only that parameter its MAC.
    expect([...((await make('throw')) ?? new Map()).keys()]).toEqual(['A']);
  });

  it('a partial failure logs one line with the error name and the count, never a value', async () => {
    const log = logger();
    const macs = await new NoEchoValueMacs({
      region: 'us-east-1',
      binding: () => 'b',
      values: { A: SECRET, B: `${SECRET}-b`, C: `${SECRET}-c` },
      parameters: new Set(['A', 'B', 'C']),
      logger: log,
      client: () => {
        let n = 0;
        return {
          send: async (command) => {
            const input = (command as unknown as { input: { Message: Uint8Array } }).input;
            if (n++ === 2) throw Object.assign(new Error(`throttled ${SECRET}`), { name: 'ThrottlingException' });
            return { KeyId: ARN, Mac: new Uint8Array(createHmac('sha256', 'k').update(input.Message).digest()) };
          },
          destroy: () => undefined,
        };
      },
    }).macs();
    expect(macs?.size).toBe(2);
    const lines = log.info.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('1 of 3 unavailable (ThrottlingException from kms:GenerateMac)');
    expect(lines[0]).not.toContain(SECRET);
    expect(lines[0]).not.toContain('throttled');
  });

  it('an error name that is not an identifier is logged as Error', async () => {
    const client = fakeClient({ fail: { name: SECRET.replace(/-/g, ' '), message: 'x' } });
    const log = logger();
    await new NoEchoValueMacs({
      region: 'us-east-1',
      binding: () => 'b',
      values: { A: SECRET },
      parameters: new Set(['A']),
      logger: log,
      client: client.factory,
    }).macs();
    expect(String(log.info.mock.calls[0]?.[0])).toContain('(Error from');
  });
});

describe('withNoEchoValueMacs (the save)', () => {
  const sources = { parameters: new Set(['P']) };
  const templateProps = { Value: { Ref: 'P' }, Other: 'x' };
  const current = new Map([['P', mac(5)]]);
  const base = (extra: Partial<ResourceState> = {}): ResourceState =>
    ({ physicalId: 'id', resourceType: 'T', properties: { Value: '***', Other: 'x' }, ...extra }) as ResourceState;

  it('stamps a record this deploy wrote', () => {
    const bag = markWrittenFromDeployedTemplate({ Value: 'v', Other: 'x' });
    expect(withNoEchoValueMacs(base(), bag, templateProps, sources, current).noEchoValueMacs).toEqual({
      Value: { P: formatNoEchoMac(mac(5)) },
    });
  });

  it('carries a record this deploy did not write', () => {
    const carried = base({ noEchoValueMacs: { Value: { P: 'old' } } });
    expect(withNoEchoValueMacs(carried, { Value: 'v' }, templateProps, sources, current)).toBe(carried);
  });

  it('keeps a kept property at its previous entry, and drops an entry with no MAC this run', () => {
    const bag = markWrittenFromDeployedTemplate({ Value: 'v' });
    const prior = base({ noEchoValueMacs: { Value: { P: 'old' } } });
    expect(
      withNoEchoValueMacs(prior, bag, templateProps, sources, current, new Set(['Value'])).noEchoValueMacs
    ).toEqual({ Value: { P: 'old' } });
    expect('noEchoValueMacs' in withNoEchoValueMacs(prior, bag, templateProps, sources, undefined)).toBe(false);
  });

  it('drops a carried entry from a written record with no template to read', () => {
    const bag = markWrittenFromDeployedTemplate({ Value: 'v' });
    const prior = base({ noEchoValueMacs: { Value: { P: 'old' } } });
    expect('noEchoValueMacs' in withNoEchoValueMacs(prior, bag, undefined, sources, current)).toBe(false);
  });
});

describe('readsOnlyNoEchoParameters: which keys a MAC match may settle', async () => {
  const { readsOnlyNoEchoParameters } = await import(
    '../../../src/deployment/deploy-engine/update/noecho-macs.js'
  );
  const noEcho = new Set(['Pw']);
  it.each([
    ['a bare NoEcho Ref', { Ref: 'Pw' }, true],
    ['an Fn::Sub of it with a pseudo parameter', { 'Fn::Sub': 'u:${Pw}@${AWS::Region}' }, true],
    ['an Fn::Sub with its own variable map', { 'Fn::Sub': ['${X}', { X: { Ref: 'Pw' } }] }, true],
    ['a Join of it and literals', { 'Fn::Join': ['', ['a', { Ref: 'Pw' }]] }, true],
    ['an object body with a literal {{resolve:}} token', { a: { Ref: 'Pw' }, b: '{{resolve:ssm:/p}}' }, true],
    ['a plain parameter Ref', { 'Fn::Join': ['', [{ Ref: 'Pw' }, { Ref: 'Plain' }]] }, false],
    ['an Fn::Sub of a plain parameter', { 'Fn::Sub': '${Pw}${Plain}' }, false],
    ['an Fn::Sub attribute placeholder', { 'Fn::Sub': '${Pw}${Db.Endpoint.Address}' }, false],
    ['a GetAtt', [{ Ref: 'Pw' }, { 'Fn::GetAtt': ['Db', 'Arn'] }], false],
    ['an ImportValue', { 'Fn::ImportValue': 'x' }, false],
    ['a condition', { 'Fn::If': ['C', { Ref: 'Pw' }, 'x'] }, false],
    ['a mapping', { 'Fn::FindInMap': ['M', 'a', 'b'] }, false],
    ['a non-constant pseudo parameter', { Ref: 'AWS::NotificationARNs' }, false],
    ['a multi-key object holding Ref', { Ref: 'Pw', Extra: 1 }, false],
    ['a multi-key object holding Fn::GetAtt', { 'Fn::GetAtt': ['Db', 'Arn'], k: 'v' }, false],
    ['a {{resolve:}} token in an Fn::Sub text', { 'Fn::Sub': '${Pw}:{{resolve:ssm:/db/host}}' }, false],
    ['a {{resolve:}} token joined with it', { 'Fn::Join': ['', [{ Ref: 'Pw' }, '{{resolve:ssm:/h}}']] }, false],
    ['a {{resolve:}} token in an Fn::Sub map', { 'Fn::Sub': ['${A}${Pw}', { A: '{{resolve:ssm:/h}}' }] }, false],
  ])('%s: %s', (_l, value, expected) => {
    expect(readsOnlyNoEchoParameters(value, noEcho)).toBe(expected);
  });
});

describe('dropFailedUpdateMacs: a failed update loses only the handed keys\' MACs', async () => {
  const { dropFailedUpdateMacs } = await import('../../../src/deployment/deploy-engine/noecho-macs.js');
  it('keeps a key the update was not handed, and drops the field once nothing is left', () => {
    const engine = { noEchoRun: { noEchoMacSent: new Map([['R', new Set(['Value'])]]) } } as never;
    const resources = {
      R: { physicalId: 'p', resourceType: 'T', properties: {}, noEchoValueMacs: { Value: { P: 'a' }, Other: { P: 'b' } } },
      S: { physicalId: 'q', resourceType: 'T', properties: {}, noEchoValueMacs: { Value: { P: 'c' } } },
    } as unknown as Record<string, ResourceState>;
    dropFailedUpdateMacs(engine, resources);
    expect(resources['R']!.noEchoValueMacs).toEqual({ Other: { P: 'b' } });
    // S was handed nothing: untouched.
    expect(resources['S']!.noEchoValueMacs).toEqual({ Value: { P: 'c' } });
    const only = { noEchoRun: { noEchoMacSent: new Map([['S', new Set(['Value'])]]) } } as never;
    dropFailedUpdateMacs(only, resources, 'R');
    expect(resources['S']!.noEchoValueMacs).toEqual({ Value: { P: 'c' } });
    dropFailedUpdateMacs(only, resources);
    expect('noEchoValueMacs' in resources['S']!).toBe(false);
  });
});

describe('macWriteOnlyKeys: one schema lookup per type per run', async () => {
  const { macWriteOnlyKeys } = await import('../../../src/deployment/deploy-engine/update/noecho-macs.js');
  it('shares the in-flight lookup and remembers a failure for the run, and a new run asks again', async () => {
    writeOnlyLookups.calls = 0;
    const run = new Map();
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => macWriteOnlyKeys('AWS::RDS::DBInstance', run))
    );
    expect(answers.every((a) => a === undefined)).toBe(true);
    expect(await macWriteOnlyKeys('AWS::RDS::DBInstance', run)).toBeUndefined();
    expect(writeOnlyLookups.calls).toBe(1);
    await macWriteOnlyKeys('AWS::ApiGateway::RestApi', run);
    expect(writeOnlyLookups.calls).toBe(2);
    await macWriteOnlyKeys('AWS::RDS::DBInstance', new Map());
    expect(writeOnlyLookups.calls).toBe(3);
  });
});

describe('a rollback or drift revert drops the MACs (go-to-k/cdkd#6146)', () => {
  // A revert sends AWS's value at a NoEcho position, not the value the
  // restored record's MACs describe: a kept MAC could confirm a value AWS no
  // longer holds, and the next deploy would skip a real change.
  it('recordAfterRollbackUpdate drops noEchoValueMacs on every arm', async () => {
    const { recordAfterRollbackUpdate } = await import(
      '../../../src/deployment/rollback-executor/replay-retry.js'
    );
    const restored = {
      physicalId: 'id',
      resourceType: 'T',
      properties: { Value: '***' },
      attributes: { A: 'a' },
      noEchoValueMacs: { Value: { P: formatNoEchoMac(mac(5)) } },
    } as ResourceState;
    for (const result of [
      undefined,
      { physicalId: 'id', wasReplaced: false },
      { physicalId: 'id', wasReplaced: false, attributes: { A: 'b' } },
    ]) {
      const next = recordAfterRollbackUpdate(restored, result as never);
      expect('noEchoValueMacs' in next).toBe(false);
      expect(next.properties).toEqual({ Value: '***' });
    }
    // Negative control: a record with no MACs is returned as it was.
    const plain = { ...restored } as ResourceState;
    delete plain.noEchoValueMacs;
    expect(recordAfterRollbackUpdate(plain, undefined)).toBe(plain);
  });
});

describe('noEchoMacVerdicts (the UPDATE arm guards)', async () => {
  const { noEchoMacVerdicts } = await import(
    '../../../src/deployment/deploy-engine/update/noecho-macs.js'
  );
  const { maskedPropertyFingerprint } = await import(
    '../../../src/deployment/masked-property-fingerprints.js'
  );
  const templateProperties = { Value: { Ref: 'P' } };
  const record = (extra: Partial<ResourceState> = {}): ResourceState =>
    ({
      physicalId: 'id',
      resourceType: 'T',
      properties: { Value: '***' },
      maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(templateProperties.Value) },
      noEchoValueMacs: { Value: { P: formatNoEchoMac(mac(1)) } },
      ...extra,
    }) as ResourceState;
  const verdict = (overrides: Record<string, unknown> = {}) =>
    noEchoMacVerdicts({
      candidates: new Set(['Value']),
      record: record(),
      templateProperties,
      sources: { parameters: new Set(['P']) },
      pendingParameterLeaves: new Map([['Value', [{ path: [], plaintext: 'v' }]]]),
      parameterCoordinates: [['Value']],
      staleCoordinates: [],
      movedAsWritten: () => false,
      unsettledNames: new Set<string>(),
      current: new Map([['P', mac(1)]]),
      ...overrides,
    });

  it('confirms a matching MAC, and proves a differing one changed', () => {
    expect([...verdict().confirmed]).toEqual(['Value']);
    expect([...verdict({ current: new Map([['P', mac(2)]]) }).changed]).toEqual(['Value']);
  });

  it.each([
    ['no text fingerprint on the record', { record: record({ maskedPropertyFingerprints: {} }) }],
    ['a moved template expression', { movedAsWritten: () => true }],
    ['an unsettled key', { unsettledNames: new Set(['Value']) }],
    ['a stale coordinate', { staleCoordinates: [['Value']] }],
    ['a leaf no parameter position covers', { parameterCoordinates: [] }],
    ['no MACs this run', { current: undefined }],
  ])('gives no verdict for %s', (_label, overrides) => {
    const out = verdict(overrides);
    expect(out.confirmed.size + out.changed.size).toBe(0);
  });
});
