import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue [#2036](https://github.com/go-to-k/cdkd/issues/2036) on `cdkd import`'s
 * observed capture, driven through the REAL `captureObservedForImportedResources`
 * and the REAL `PublicSsmProver` / resolver — only the leaf `SSMClient` is
 * faked, keyed per (region, parameter name), so the far side of the proof is
 * exercised rather than mocked.
 *
 * `cdkd import`'s warn path can leave a PUBLIC `{{resolve:ssm:...}}` expression
 * embedded in a longer `properties` leaf. The capture redacts the readback
 * against those properties with an empty map, so it used to take the expression
 * over the value AWS holds. It now keeps the value when a no-decryption
 * `GetParameter` in the stack's region proves the parameter public.
 */

interface FakeSend {
  region: string | undefined;
  input: { Name?: string; WithDecryption?: boolean };
}

const { responses, ssmSends, FakeSSMClient } = vi.hoisted(() => {
  const responses = new Map<string, unknown>();
  const ssmSends: FakeSend[] = [];
  class FakeSSMClient {
    readonly ctorConfig: { region?: string };
    readonly config: { region: () => Promise<string> };
    constructor(ctorConfig: { region?: string } = {}) {
      this.ctorConfig = ctorConfig;
      this.config = {
        region: () => {
          const region = this.ctorConfig.region || process.env['AWS_REGION'];
          return region ? Promise.resolve(region) : Promise.reject(new Error('Region is missing'));
        },
      };
    }
    async send(command: { input?: FakeSend['input'] }): Promise<unknown> {
      const region = await this.config.region().catch(() => undefined);
      const input = command.input ?? {};
      ssmSends.push({ region, input });
      const response = responses.get(`${String(region)}|${String(input.Name)}`);
      if (response === undefined) {
        throw new Error(`no ssm response primed for ${String(region)}|${String(input.Name)}`);
      }
      return response;
    }
    destroy(): void {}
  }
  return { responses, ssmSends, FakeSSMClient };
});

vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SSMClient: FakeSSMClient };
});

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

import {
  captureObservedForImportedResources,
  ObservedBaselineRefusals,
} from '../../../src/cli/commands/import.js';
import { getLogger } from '../../../src/utils/logger.js';
import { AwsClients, setAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const PUBLIC_NAME = '/import/public-host';
const SECURE_NAME = '/import/secure-token';
const PUBLIC = `{{resolve:ssm:${PUBLIC_NAME}}}`;
const SECURE = `{{resolve:ssm:${SECURE_NAME}}}`;
const PUBLIC_VALUE = 'db.public.internal';
const SECURE_VALUE = 'import-decrypted-secure-value';

beforeEach(() => {
  responses.clear();
  ssmSends.length = 0;
  resetAccountInfoCache();
  setAwsClients(new AwsClients({ region: 'us-east-1' }));
  for (const region of ['us-east-1', 'us-west-2']) {
    responses.set(`${region}|${PUBLIC_NAME}`, {
      Parameter: { Value: PUBLIC_VALUE, Type: 'String' },
    });
    responses.set(`${region}|${SECURE_NAME}`, {
      Parameter: { Value: 'AQICAH-ciphertext', Type: 'SecureString' },
    });
  }
});

afterEach(() => {
  resetAwsClients();
  resetAccountInfoCache();
});

async function capture(
  properties: Record<string, unknown>,
  readback: Record<string, unknown>,
  options: { region?: string; producerRegion?: string } = {}
): Promise<unknown> {
  const region = options.region ?? 'us-east-1';
  const state: StackState = {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'import-2036',
    region,
    resources: {
      Res: { physicalId: 'res-phys', resourceType: 'AWS::SQS::Queue', properties },
    },
    outputs: {},
    lastModified: 0,
    ...(options.producerRegion !== undefined && {
      imports: [
        {
          exportName: 'X',
          sourceStack: 'Producer',
          sourceRegion: options.producerRegion,
        } as unknown as NonNullable<StackState['imports']>[number],
      ],
    }),
  };
  const provider = { readCurrentState: async () => structuredClone(readback) };
  const registry = {
    getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
  } as unknown as Parameters<typeof captureObservedForImportedResources>[1];
  await captureObservedForImportedResources(
    state,
    registry,
    getLogger(),
    new ObservedBaselineRefusals(new Set()),
    new Set(['Res']),
    region
  );
  return state.resources['Res']!.observedProperties;
}

describe('cdkd import observed capture: a PUBLIC ssm mixed leaf (issue #2036)', () => {
  it('keeps the value AWS holds once GetParameter (no decryption) proves the parameter public', async () => {
    const observed = await capture(
      { Url: `https://${PUBLIC}/health` },
      { Url: `https://${PUBLIC_VALUE}/health` }
    );
    expect(observed).toEqual({ Url: `https://${PUBLIC_VALUE}/health` });
    expect(ssmSends).toEqual([
      { region: 'us-east-1', input: { Name: PUBLIC_NAME, WithDecryption: false } },
    ]);
  });

  it('a SecureString mixed leaf is still refused, and nothing is decrypted to decide it', async () => {
    const observed = await capture(
      { Conn: `pw=${SECURE};host=h` },
      { Conn: `pw=${SECURE_VALUE};host=h` }
    );
    expect(observed).toEqual({ Conn: `pw=${SECURE};host=h` });
    expect(JSON.stringify(observed)).not.toContain(SECURE_VALUE);
    expect(ssmSends.map((s) => s.input.WithDecryption)).toEqual([false]);
  });

  it('asks in the STACK region it is handed', async () => {
    await capture(
      { Url: `https://${PUBLIC}/health` },
      { Url: `https://${PUBLIC_VALUE}/health` },
      { region: 'us-west-2' }
    );
    expect(ssmSends.map((s) => s.region)).toEqual(['us-west-2']);
  });

  it('a stack that reads from another region asks nothing and keeps the over-redaction', async () => {
    const observed = await capture(
      { Url: `https://${PUBLIC}/health` },
      { Url: `https://${PUBLIC_VALUE}/health` },
      { producerRegion: 'eu-west-1' }
    );
    expect(ssmSends).toHaveLength(0);
    expect(observed).toEqual({ Url: `https://${PUBLIC}/health` });
  });
});
