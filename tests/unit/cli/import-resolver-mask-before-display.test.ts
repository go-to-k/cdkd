/**
 * go-to-k/cdkd#3479: the unresolved-intrinsics warning in `cdkd import` now
 * passes the resolver's error text through `displayAwsMessage`, and it must do
 * so AFTER `maskSecretsInText`. The mask matches the RAW plaintext, so a
 * display pass running first would rewrite a plaintext carrying a character
 * it maps (here `U+0085`) and the needle would no longer match: the secret
 * would print with a space where the NEL was.
 *
 * The rejection is a NON-`Error` value quoting the assembled parameter name,
 * the one population only `import.ts`'s own mask covers (the resolver masks
 * every `Error` it rethrows) — see `import-resolver-error-masking.test.ts`,
 * whose harness this trims.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const SECRET_ID = 'cdkd-import-mask-order-probe';
const NEL = String.fromCharCode(0x85);
/** Two halves either side of a character `displaySafe` maps to a space. */
const PASSWORD = `Hx7kQ2${NEL}Wm9pZ4`;

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(command: { input?: { SecretId?: string } }): Promise<unknown> {
      if (command.input?.SecretId !== SECRET_ID) throw new Error('unexpected secret id');
      return { SecretString: JSON.stringify({ password: PASSWORD }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

const sentNames = vi.hoisted(() => [] as string[]);
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSSMClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(command: { input?: { Name?: string } }): Promise<unknown> {
      const name = String(command.input?.Name);
      sentNames.push(name);
      // IAM's wording, quoting the resource — which for a name assembled out
      // of a secret IS the plaintext. Thrown as a string: not an `Error`.
      throw (
        `AccessDeniedException: User: arn:aws:iam::123456789012:user/cdkd is not authorized ` +
        `to perform: ssm:GetParameter on resource: ${name}`
      );
    }
    destroy(): void {}
  }
  return { ...actual, SSMClient: FakeSSMClient };
});

const { resolveImportedProperties } = await import('../../../src/cli/commands/import.js');
const { getLogger } = await import('../../../src/utils/logger.js');

const TEMPLATE: CloudFormationTemplate = {
  Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: {} } },
};

function makeState(properties: Record<string, unknown>): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'import-mask-order-stack',
    region: 'us-east-1',
    resources: {
      Res: { physicalId: 'res-phys', resourceType: 'AWS::SQS::Queue', properties },
    },
    outputs: {},
    lastModified: 0,
  } satisfies StackState;
}

describe('cdkd import masks the resolver error text BEFORE sanitizing it (go-to-k/cdkd#3479)', () => {
  it('a plaintext carrying a character the display pass maps is still masked', async () => {
    const state = makeState({
      Password: {
        'Fn::Sub': [
          '{{resolve:ssm:/app/${Pw}}}',
          { Pw: `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password}}` },
        ],
      },
    });
    await resolveImportedProperties(state, TEMPLATE, 'us-east-1', undefined as never, getLogger());

    expect(sentNames, 'the premise: the assembled name was looked up').toEqual([
      `/app/${PASSWORD}`,
    ]);
    const text = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('Failed to resolve intrinsics');
    expect(text).toContain('on resource: /app/***');
    // Neither half, in either spelling of the separator.
    expect(text).not.toContain('Hx7kQ2');
    expect(text).not.toContain('Wm9pZ4');
  });
});
