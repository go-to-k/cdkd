import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#4682: a custom resource whose record holds `***` at a NoEcho
 * coordinate is DELETED with today's value when the caller re-resolved it
 * (`DeleteContext.noEchoDeleteValues`), and stays skipped when any masked
 * coordinate is left without one. A `***` no coordinate names is skipped too
 * (the issue's second decision). The value reaches the handler's payload and
 * nothing else: the record is not mutated and every warning is masked.
 */
const mockLambdaSend = vi.fn();
const mockS3Send = vi.fn();
const mockStsSend = vi.fn(() => Promise.resolve({ Account: '123456789012' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: vi.fn() },
    s3: { send: mockS3Send },
    sts: { send: mockStsSend },
  }),
}));

const logged = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const record = (...args: unknown[]): void => void logged.push(args.map(String).join(' '));
  const child = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: (): unknown => child,
  };
  return { getLogger: () => ({ ...child, child: () => child }) };
});

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: () => Promise.resolve('https://s3.example.com/presigned-url'),
}));

import {
  CustomResourceProvider,
  CR_NOECHO_PROPERTIES_SKIP_REASON,
  CR_MASKED_PROPERTIES_SKIP_REASON,
} from '../../../src/provisioning/providers/custom-resource-provider.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { NoEchoDeleteValues } from '../../../src/deployment/noecho-delete-reresolution.js';

const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:Stack-CrHandler';
const VALUE = 'reresolved-noecho-value-4682';

function values(
  leaves: { coordinate: (string | number)[]; value: unknown }[]
): NoEchoDeleteValues {
  return { leaves, maskSecrets: (text) => text.split(VALUE).join(SECRET_MASK) };
}

function wireHandlerResponse(response: Record<string, unknown>): void {
  mockS3Send.mockImplementation(() => Promise.resolve({}));
  mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'InvokeCommand') {
      return Promise.resolve({ Payload: Buffer.from(JSON.stringify(response)) });
    }
    return Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } });
  });
}

function sentPayload(): Record<string, unknown> {
  const invoke = mockLambdaSend.mock.calls.find(
    (c) => (c[0] as { constructor: { name: string } }).constructor.name === 'InvokeCommand'
  );
  expect(invoke).toBeDefined();
  const input = (invoke![0] as { input: { Payload: Uint8Array } }).input;
  return JSON.parse(Buffer.from(input.Payload).toString()) as Record<string, unknown>;
}

const provider = (): CustomResourceProvider =>
  new CustomResourceProvider({ responseBucket: 'test-bucket' });

describe('CustomResourceProvider.delete: re-resolved NoEcho coordinates (go-to-k/cdkd#4682)', () => {
  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockS3Send.mockReset();
    logged.length = 0;
    resetAccountInfoCache();
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
  });
  afterEach(() => {
    delete process.env['CDKD_CR_AUTHZ_MAX_RETRIES'];
  });

  it('sends the re-resolved value in ResourceProperties and reports DELETED; the record keeps the mask', async () => {
    wireHandlerResponse({ Status: 'SUCCESS', PhysicalResourceId: 'phys-1' });
    const properties = {
      ServiceToken: SERVICE_TOKEN,
      Config: { Password: SECRET_MASK, User: 'admin' },
    };
    const result = await provider().delete('SeedCr', 'phys-1', 'Custom::Seed', properties, {
      recordedNoEchoLeaves: [['Config', 'Password']],
      noEchoDeleteValues: values([{ coordinate: ['Config', 'Password'], value: VALUE }]),
      stackDestroy: true,
    });

    expect(result).toBeUndefined();
    const payload = sentPayload();
    expect(payload['RequestType']).toBe('Delete');
    expect(payload['ResourceProperties']).toEqual({
      ServiceToken: SERVICE_TOKEN,
      Config: { Password: VALUE, User: 'admin' },
    });
    // The record handed in is never mutated.
    expect(properties.Config.Password).toBe(SECRET_MASK);
    expect(logged.join('\n')).not.toContain(VALUE);
  });

  it('skips with the NoEcho reason while ANY masked coordinate has no value, and makes no AWS call', async () => {
    wireHandlerResponse({ Status: 'SUCCESS' });
    const result = await provider().delete(
      'SeedCr',
      'phys-1',
      'Custom::Seed',
      { ServiceToken: SERVICE_TOKEN, A: SECRET_MASK, B: SECRET_MASK },
      {
        recordedNoEchoLeaves: [['A'], ['B']],
        noEchoDeleteValues: values([{ coordinate: ['A'], value: VALUE }]),
        stackDestroy: true,
      }
    );
    expect(result).toEqual({ outcome: 'skipped', reason: CR_NOECHO_PROPERTIES_SKIP_REASON });
    expect(mockLambdaSend).not.toHaveBeenCalled();
    const text = logged.join('\n');
    // Names only the coordinate left unresolved, and when cdkd re-resolves.
    expect(text).toContain('recorded in state with B holding');
    expect(text).toContain("only where it holds the template ('cdkd destroy'");
    expect(text).not.toContain(VALUE);
  });

  it('skips with the NoEcho reason when no values were offered (a template-less caller)', async () => {
    const result = await provider().delete(
      'SeedCr',
      'phys-1',
      'Custom::Seed',
      { ServiceToken: SERVICE_TOKEN, A: SECRET_MASK },
      { recordedNoEchoLeaves: [['A']], stackDestroy: true }
    );
    expect(result).toEqual({ outcome: 'skipped', reason: CR_NOECHO_PROPERTIES_SKIP_REASON });
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it.each([
    ['a pre-v11 record (no coordinates)', undefined, undefined],
    ['a mask beside a re-resolved coordinate', [['A']], [{ coordinate: ['A'], value: VALUE }]],
    ['an empty coordinate list', [], undefined],
  ])(
    'skips a mask no coordinate names with its own reason: %s',
    async (_label, leaves, offered) => {
      const result = await provider().delete(
        'SeedCr',
        'phys-1',
        'Custom::Seed',
        { ServiceToken: SERVICE_TOKEN, A: SECRET_MASK, Joined: SECRET_MASK },
        {
          stackDestroy: true,
          ...(leaves !== undefined && { recordedNoEchoLeaves: leaves }),
          ...(offered !== undefined && { noEchoDeleteValues: values(offered) }),
        }
      );
      expect(result).toEqual({ outcome: 'skipped', reason: CR_MASKED_PROPERTIES_SKIP_REASON });
      expect(mockLambdaSend).not.toHaveBeenCalled();
      expect(logged.join('\n')).toContain('which no NoEcho coordinate of the record names');
      // The import / scrub remedy: a deploy records the positions first.
      expect(logged.join('\n')).toContain("a 'cdkd deploy' of the app first records");
    }
  );

  it("masks the handler's FAILED reason when it echoes the re-resolved value", async () => {
    wireHandlerResponse({ Status: 'FAILED', Reason: `could not revoke ${VALUE}` });
    const result = await provider().delete(
      'SeedCr',
      'phys-1',
      'Custom::Seed',
      { ServiceToken: SERVICE_TOKEN, A: SECRET_MASK },
      {
        recordedNoEchoLeaves: [['A']],
        noEchoDeleteValues: values([{ coordinate: ['A'], value: VALUE }]),
        stackDestroy: true,
      }
    );
    expect(result).toMatchObject({ outcome: 'skipped' });
    const text = logged.join('\n');
    expect(text).toContain(`could not revoke ${SECRET_MASK}`);
    expect(text).not.toContain(VALUE);
  });

  it('masks an invoke error and a crashed handler log tail carrying the value', async () => {
    const tail = Buffer.from(`START\n{"ResourceProperties":{"A":"${VALUE}"}}\nEND`).toString(
      'base64'
    );
    mockS3Send.mockImplementation(() => Promise.resolve({}));
    mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'InvokeCommand') {
        return Promise.resolve({
          FunctionError: 'Unhandled',
          LogResult: tail,
          Payload: Buffer.from(JSON.stringify({ errorMessage: `bad token ${VALUE}` })),
        });
      }
      return Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } });
    });
    const result = await provider().delete(
      'SeedCr',
      'phys-1',
      'Custom::Seed',
      { ServiceToken: SERVICE_TOKEN, A: SECRET_MASK },
      {
        recordedNoEchoLeaves: [['A']],
        noEchoDeleteValues: values([{ coordinate: ['A'], value: VALUE }]),
        stackDestroy: true,
      }
    );
    expect(result).toMatchObject({ outcome: 'skipped' });
    const text = logged.join('\n');
    expect(text).toContain('bad token');
    expect(text).not.toContain(VALUE);
  });

  it("masks a FAILED reply's unclassified log tail and a transient-authz retry's reason", async () => {
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '1';
    const tail = Buffer.from(`START\nhandler saw token ${VALUE}\nEND`).toString('base64');
    let invokes = 0;
    mockS3Send.mockImplementation(() => Promise.resolve({}));
    mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name !== 'InvokeCommand') {
        return Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } });
      }
      invokes += 1;
      const reply =
        invokes === 1
          ? { Status: 'FAILED', Reason: `role is not authorized to perform ssm:Get for ${VALUE}` }
          : { Status: 'FAILED', Reason: 'teardown refused' };
      return Promise.resolve({ Payload: Buffer.from(JSON.stringify(reply)), LogResult: tail });
    });
    await provider().delete(
      'SeedCr',
      'phys-1',
      'Custom::Seed',
      { ServiceToken: SERVICE_TOKEN, A: SECRET_MASK },
      {
        recordedNoEchoLeaves: [['A']],
        noEchoDeleteValues: values([{ coordinate: ['A'], value: VALUE }]),
        stackDestroy: true,
      }
    );
    const text = logged.join('\n');
    expect(invokes).toBe(2);
    expect(text).toContain('transient IAM-authorization FAILED');
    expect(text).toContain('handler saw token');
    expect(text).not.toContain(VALUE);
  });
});
