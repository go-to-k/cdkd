/**
 * `cdkd import` persists a 1-3 character secret embedded in a resolved leaf as
 * its `{{resolve:...}}` expression (issue
 * [#2745](https://github.com/go-to-k/cdkd/issues/2745), third site).
 *
 * Such a plaintext sits below the value scan's needle floor, and the span arms
 * in `secret-redaction.ts` write it as its token only on a bag whose
 * provenance is proven by `markSameGenerationBag`. Import's
 * `resolveImportedProperties` resolves the imported template with its own
 * resolver, which records the pairs — the same evidence the deploy engine's
 * create arm has — but the bag it handed to the redaction was never marked, so
 * an imported template whose leaf embeds `port:` + a 2-character reference
 * persisted `port:q7`.
 *
 * THE REAL RESOLVER, not a fake, for the reason
 * `import-attributes-redaction.test.ts` gives: what populates
 * `recordedSecretValues` and its pairs is the resolver's own decrypt, so a
 * fake that handed over a pre-built map would be asserting the fixture rather
 * than the code. Of the AWS clients only Secrets Manager is mocked, and it
 * RECORDS what it was asked for; the logger and the Cloud Control type check
 * are stubbed exactly as the sibling test stubs them.
 *
 * WHY EVERY CASE ALSO ASSERTS THE RESOLVE SUCCEEDED. For the literal shape the
 * expected persisted leaf is byte-identical to the template's, and
 * `resolveImportedProperties` keeps the raw bag when the resolve THROWS — so
 * "the leaf holds the expression" alone is satisfied by a lookup that never
 * happened. Each case therefore also asserts the resource was not refused, no
 * failure was warned, and the secret was actually fetched.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const SECRET_NAME = 'cdkd-2745-import-pin';
const SECRET_ARN = `arn:aws:secretsmanager:us-east-1:111111111111:secret:${SECRET_NAME}-AbCdEf`;
/** TWO characters: below `MIN_NEEDLE_LENGTH`, where the value scan is silent. */
const PIN = 'q7';

/** Every `SecretId` the fake client was asked for, in order. */
const askedSecretIds: string[] = [];

const warn = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn,
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
      const id = command.input?.SecretId;
      if (id !== undefined) askedSecretIds.push(id);
      if (id !== SECRET_NAME && id !== SECRET_ARN) {
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }
      return { SecretString: JSON.stringify({ pin: PIN }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

const { resolveImportedProperties } = await import('../../../src/cli/commands/import.js');
const { getLogger } = await import('../../../src/utils/logger.js');
const { isSameGenerationBag } = await import('../../../src/deployment/secret-redaction.js');

/** The literal leaf: the name-form token embedded in surrounding text. */
const LITERAL_LEAF = `port:{{resolve:secretsmanager:${SECRET_NAME}:SecretString:pin}}`;
/** The L2 shape: the ARN `Ref` INSIDE the token, prefix fused into the opening part. */
const L2_JOIN = {
  'Fn::Join': ['', ['port:{{resolve:secretsmanager:', { Ref: 'Sec' }, ':SecretString:pin::}}']],
};
/** What the resolver assembles for `L2_JOIN`, and what state must hold. */
const L2_EXPRESSION = `port:{{resolve:secretsmanager:${SECRET_ARN}:SecretString:pin::}}`;

function stateWith(properties: Record<string, unknown>): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'import-2745',
    region: 'us-east-1',
    resources: {
      Sec: {
        physicalId: SECRET_ARN,
        resourceType: 'AWS::SecretsManager::Secret',
        properties: { Name: SECRET_NAME },
      },
      Param: {
        physicalId: 'param-phys',
        resourceType: 'AWS::SSM::Parameter',
        properties: structuredClone(properties),
      },
    },
    outputs: {},
    lastModified: 0,
  } satisfies StackState;
}

const TEMPLATE = {
  Resources: {
    Sec: { Type: 'AWS::SecretsManager::Secret', Properties: { Name: SECRET_NAME } },
    Param: { Type: 'AWS::SSM::Parameter', Properties: {} },
  },
} as CloudFormationTemplate;

async function runImport(properties: Record<string, unknown>): Promise<{
  properties: Record<string, unknown>;
  refused: Set<string>;
  asked: string[];
}> {
  askedSecretIds.length = 0;
  warn.mockClear();
  const state = stateWith(properties);
  const refused = await resolveImportedProperties(
    state,
    TEMPLATE,
    'us-east-1',
    {} as never,
    getLogger()
  );
  return { properties: state.resources['Param']!.properties, refused, asked: [...askedSecretIds] };
}

function expectResolved(
  run: { properties: Record<string, unknown>; refused: Set<string> },
  fetchedAs: string,
  asked: string[]
): void {
  expect(run.refused.has('Param')).toBe(false);
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Failed to resolve intrinsics'));
  expect(asked).toContain(fetchedAs);
  // The mark goes on the redaction INPUT; the record holds the redacted COPY,
  // unmarked. A refactor assigning the marked resolved bag to `properties`
  // would hand every later reader an object that claims same-generation
  // provenance it no longer has (maintainer review of PR 3052).
  expect(isSameGenerationBag(run.properties)).toBe(false);
}

describe('cdkd import persists a sub-floor embedded secret as its expression (issue #2745)', () => {
  it('for a LITERAL leaf embedding a 2-character reference', async () => {
    const run = await runImport({ Type: 'String', Value: LITERAL_LEAF });

    expect(run.properties).toEqual({ Type: 'String', Value: LITERAL_LEAF });
    expectResolved(run, SECRET_NAME, run.asked);
  });

  it('for the L2 Fn::Join shape, as the assembled ARN-form expression (the first site decides this)', async () => {
    const run = await runImport({ Type: 'String', Value: L2_JOIN });

    expect(run.properties).toEqual({ Type: 'String', Value: L2_EXPRESSION });
    expectResolved(run, SECRET_ARN, run.asked);
  });

  it('keeps the resolved bag as is when the resolver recorded nothing', async () => {
    // No reference anywhere: nothing to redact, and the literal that merely
    // LOOKS like the plaintext is the user's own value.
    const run = await runImport({ Type: 'String', Value: `port:${PIN}` });

    expect(run.properties).toEqual({ Type: 'String', Value: `port:${PIN}` });
    expect(run.refused.has('Param')).toBe(false);
    expect(run.asked).toEqual([]);
  });
});
