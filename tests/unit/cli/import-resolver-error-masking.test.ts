/**
 * Issue #2803: `cdkd import` reported an intrinsic-resolution failure with the
 * resolver's error text UNMASKED. Its per-resource secrets bag was declared
 * INSIDE the `try` that calls `resolver.resolve(...)`, so the `catch` could not
 * name it, and the warn interpolated `err.message` verbatim at default
 * verbosity — in the command whose stated contract is to persist the
 * `{{resolve:...}}` EXPRESSION and never the value.
 *
 * This is the third instance of one class: issue #2728 fixed
 * `DeployEngine.handleOutputResolutionFailure`, issues #2531 / #2562 fixed
 * `cdkd scrub`. `rollback-executor.ts` and `drift.ts` already hoist their bags
 * above the `try` and say why at the declaration.
 *
 * WHY THE REAL RESOLVER, NOT A MOCKED ONE. The exposure depends on what the
 * resolver ECHOES, so a fake that throws a message with a plaintext in it would
 * be manufacturing the very thing under test. The shape below is one the
 * resolver builds itself, and is the same one issue #2728's reachability case
 * uses: an `Fn::Sub` whose variable resolves the secret's `password` key, and
 * whose body uses that VALUE as the JSON key of a second reference to the same
 * secret. The second lookup SUCCEEDS and then fails to find the key, so the
 * resolver's own `key '<password>' not found in secret '<id>'` carries the
 * plaintext the same walk just recorded into the bag.
 *
 * `cdkd import` sets no `skipDynamicReferences`, so the resolve genuinely
 * decrypts — which is what makes this reachable here and not, say, in the
 * `cdkd diff` resolve contexts that do set it.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const SECRET_ID = 'cdkd-import-mask-probe';
const PASSWORD = 'Zk7pQw2mVx';

const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: debugSpy,
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
    async send(command: {
      input?: { SecretId?: string };
      constructor: { name: string };
    }): Promise<unknown> {
      if (command.constructor.name !== 'GetSecretValueCommand') {
        throw new Error(`unexpected Secrets Manager command ${command.constructor.name}`);
      }
      if (command.input?.SecretId !== SECRET_ID) {
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }
      return { SecretString: JSON.stringify({ username: 'cdkd-user', password: PASSWORD }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

const { resolveImportedProperties } = await import('../../../src/cli/commands/import.js');
const { getLogger } = await import('../../../src/utils/logger.js');

const ref = (jsonKey: string): string =>
  `{{resolve:secretsmanager:${SECRET_ID}:SecretString:${jsonKey}}}`;

/**
 * The `Fn::Sub` that makes the resolver echo its own input: `${Pw}` resolves to
 * the password, and the assembled body is then a second dynamic reference whose
 * JSON key IS that password.
 */
const ECHOING_PROPERTY = {
  'Fn::Sub': [
    `{{resolve:secretsmanager:${SECRET_ID}:SecretString:\${Pw}}}`,
    { Pw: ref('password') },
  ],
};

function makeState(properties: Record<string, unknown>): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'import-mask-stack',
    region: 'us-east-1',
    resources: {
      Res: {
        physicalId: 'res-phys',
        resourceType: 'AWS::SQS::Queue',
        properties,
      },
    },
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;
}

const TEMPLATE: CloudFormationTemplate = {
  Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: {} } },
};

/** Everything the warn spy was handed, joined — the sink under test. */
function warnedText(): string {
  return warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
}

async function runWalk(properties: Record<string, unknown>): Promise<StackState> {
  const state = makeState(properties);
  await resolveImportedProperties(
    state,
    TEMPLATE,
    'us-east-1',
    undefined as never,
    getLogger()
  );
  return state;
}

describe('cdkd import masks the resolver error text it logs (issue #2803)', () => {
  beforeEach(() => {
    warnSpy.mockClear();
    debugSpy.mockClear();
  });

  it('the resolver genuinely echoes the plaintext — the premise this file rests on', async () => {
    // Measured at the resolver, not asserted from the fix's own output: if the
    // message never carried the password, every case below would pass against
    // an unmasked build too. Reached by resolving the same shape directly.
    const { IntrinsicFunctionResolver } = await import(
      '../../../src/deployment/intrinsic-function-resolver.js'
    );
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const thrown = await resolver
      .resolve(ECHOING_PROPERTY, {
        template: TEMPLATE,
        resources: {},
        recordedSecretValues: new Map<string, string>(),
      } as never)
      .then(
        () => undefined,
        (reason: unknown) => reason
      );

    expect(thrown, 'the second lookup must fail, or there is no message').toBeInstanceOf(Error);
    expect(
      (thrown as Error).message,
      'the resolver echoes the resolved password as the missing JSON key'
    ).toContain(PASSWORD);
  });

  it('the warn carries the mask, not the plaintext', async () => {
    await runWalk({ Password: ECHOING_PROPERTY });

    const text = warnedText();
    expect(text, 'the failure is still reported').toContain('Failed to resolve intrinsics');
    expect(text, 'the plaintext must not reach the terminal').not.toContain(PASSWORD);
    expect(text, 'and it is masked rather than dropped').toContain('***');
  });

  it('a value the walk never recorded is left alone — the mask is a needle set, not a blanket', async () => {
    // The control. Without it, a fix that replaced the whole message with `***`
    // would pass the case above and destroy every diagnostic in the process.
    await runWalk({
      Password: ECHOING_PROPERTY,
      Note: 'queue-for-billing',
    });

    const text = warnedText();
    expect(text, 'the resource id is still named').toContain('Res');
    expect(text, 'the resource type is still named').toContain('AWS::SQS::Queue');
    expect(text, 'the remedy sentence survives').toContain('cdkd state orphan');
  });

  it('the resource keeps its raw intrinsic, so masking did not change the walk', async () => {
    const state = await runWalk({ Password: ECHOING_PROPERTY });

    expect(
      state.resources['Res']?.properties['Password'],
      'a failed resolution leaves the original shape in state'
    ).toEqual(ECHOING_PROPERTY);
  });

  it('a failure with NO secret recorded is reported verbatim', async () => {
    // The other end of the needle-set property: nothing was decrypted, so the
    // mask is a no-op and the message must not be degraded.
    await runWalk({ Ref: { Ref: 'NoSuchResource' } });

    const text = warnedText();
    expect(text, 'the failure is reported').toContain('Failed to resolve intrinsics');
    expect(text, 'with nothing recorded there is nothing to mask').not.toContain('***');
  });
});
