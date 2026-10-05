import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue [#2036](https://github.com/go-to-k/cdkd/issues/2036): why `cdkd import`'s
 * observed capture needs no public-ssm proof.
 *
 * A LEGACY record whose `properties` still spell a public `{{resolve:ssm:...}}`
 * reference inside a longer value is the only shape the proof could admit. A
 * selective import carries such a record over from existing state without
 * rebuilding it, but the resolve walk re-resolves EVERY record in the stack:
 * the public reference resolves, its opener is lost, and the lost-opener arm
 * refuses the record's baseline. So the capture never positions a readback
 * against that expression, and there is nothing for a proof to lift. This
 * pins that premise (the PR #4575 body relies on it); only the leaf
 * `SSMClient` is faked.
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
  resolveImportedProperties,
} from '../../../src/cli/commands/import.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { getLogger } from '../../../src/utils/logger.js';
import { AwsClients, setAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const PUBLIC_NAME = '/import/public-host';
const PUBLIC = `{{resolve:ssm:${PUBLIC_NAME}}}`;
const PUBLIC_VALUE = 'db.public.internal';

beforeEach(() => {
  responses.clear();
  ssmSends.length = 0;
  resetAccountInfoCache();
  setAwsClients(new AwsClients({ region: 'us-east-1' }));
  responses.set(`us-east-1|${PUBLIC_NAME}`, { Parameter: { Value: PUBLIC_VALUE, Type: 'String' } });
});

afterEach(() => {
  resetAwsClients();
  resetAccountInfoCache();
});

describe('a PRESERVED legacy record with a public ssm mixed leaf (selective import)', () => {
  it.each([
    ['the template still declares it', true],
    ['the template no longer declares it', false],
  ])('is re-resolved and REFUSED a baseline, never re-captured: %s', async (_label, declared) => {
    const legacy = `https://${PUBLIC}/health`;
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      stackName: 'import-2036',
      region: 'us-east-1',
      resources: {
        Legacy: {
          physicalId: 'legacy-phys',
          resourceType: 'AWS::SQS::Queue',
          properties: { Url: legacy },
          observedProperties: { Url: legacy },
        },
      },
      outputs: {},
      lastModified: 0,
    };
    const template = {
      Resources: declared
        ? { Legacy: { Type: 'AWS::SQS::Queue', Properties: { Url: legacy } } }
        : {},
    } as unknown as CloudFormationTemplate;
    const refusals = await resolveImportedProperties(
      state,
      template,
      'us-east-1',
      undefined as never,
      getLogger()
    );
    const reads: string[] = [];
    const provider = {
      readCurrentState: async (physicalId: string) => {
        reads.push(physicalId);
        return { Url: `https://${PUBLIC_VALUE}/health` };
      },
    };
    const registry = {
      getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    } as unknown as Parameters<typeof captureObservedForImportedResources>[1];
    // NOT rebuilt by this run: the preserved-record path.
    await captureObservedForImportedResources(state, registry, getLogger(), refusals, new Set());
    const record = state.resources['Legacy']!;
    expect(ssmSends).toHaveLength(1);
    expect(record.properties).toEqual({ Url: `https://${PUBLIC_VALUE}/health` });
    expect(record.observedBaselineRefused).toBe(true);
    expect(Object.hasOwn(record, 'observedProperties')).toBe(false);
    expect(reads).toEqual([]);
  });
});
