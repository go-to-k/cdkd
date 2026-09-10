/**
 * `cdkd import` redacts the `attributes` bag against the per-resource secrets
 * map (issue [#2847](https://github.com/go-to-k/cdkd/issues/2847)).
 *
 * `attributes` is an AWS READBACK: for a resource whose template property is a
 * `{{resolve:secretsmanager:...}}` reference, the value AWS echoes back in that
 * bag is the DECRYPTED one. `properties` has been redacted since the original
 * GHSA fix and `observedProperties` since issue #2828; this bag reached no
 * redactor at all, at either call site.
 *
 * THE REAL RESOLVER, not a fake — the same reason
 * `import-observed-baseline-refusal-matrix.test.ts` gives: what populates
 * `recordedSecretValues` is the resolver's own decrypt, so a fake that handed
 * over a pre-built map would be asserting the fixture rather than the code. The
 * Secrets Manager client is mocked; nothing between it and the redactor is.
 *
 * WHY NO CASE IS PHRASED AS A BARE NEGATIVE. "state.json holds no plaintext"
 * passes perfectly when the key was never written, so it survives a mutation
 * that empties the bag — and it also survives one that DROPS the key, which is
 * the change this fix specifically must not make. Every case therefore asserts
 * the whole bag with `toEqual`: the key is present AND holds the token.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const SECRET_ID = 'cdkd-2847-attrs';
const PLAINTEXT = 'attrs-decrypted-value-2847';
/** A SECOND, DIFFERENT secret — the throw-arm case needs one that resolves. */
const SECRET_ID_2 = 'cdkd-2847-attrs-two';
const PLAINTEXT_2 = 'attrs-second-decrypted-2847';

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

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(command: { input?: { SecretId?: string } }): Promise<unknown> {
      if (command.input?.SecretId === SECRET_ID_2) {
        return { SecretString: JSON.stringify({ pw: PLAINTEXT_2 }) };
      }
      if (command.input?.SecretId !== SECRET_ID) {
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }
      return { SecretString: JSON.stringify({ pw: PLAINTEXT }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

const { resolveImportedProperties } = await import('../../../src/cli/commands/import.js');
const { getLogger } = await import('../../../src/utils/logger.js');

const TOKEN = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:pw::}}`;
const TOKEN_2 = `{{resolve:secretsmanager:${SECRET_ID_2}:SecretString:pw::}}`;
/** A token whose secret does not exist, so resolving it THROWS. */
const MISSING_TOKEN = '{{resolve:secretsmanager:cdkd-2847-absent:SecretString:pw::}}';

function stateWith(
  properties: Record<string, unknown>,
  attributes: Record<string, unknown> | undefined
): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'attrs-stack',
    region: 'us-east-1',
    resources: {
      Res: {
        physicalId: 'res-phys',
        resourceType: 'AWS::SQS::Queue',
        properties: structuredClone(properties),
        ...(attributes !== undefined && { attributes: structuredClone(attributes) }),
      },
    },
    outputs: {},
    lastModified: 0,
  } satisfies StackState;
}

const TEMPLATE = {
  Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: {} } },
} as CloudFormationTemplate;

async function run(state: StackState): Promise<void> {
  await resolveImportedProperties(
    state,
    TEMPLATE,
    'us-east-1',
    // The walk touches the state backend only for cross-stack intrinsics,
    // which these fixtures do not carry.
    {} as never,
    getLogger()
  );
}

describe('cdkd import redacts ResourceState.attributes (issue #2847)', () => {
  it('persists the MASK, not a raw physical id, for a Ref whose recovery key is masked', async () => {
    // BLOCKER B2 (issue #2847 round-3 review). `import.ts` builds its resolver
    // context with NO `redactedAttributeReads`, so it has nowhere to record a
    // refusal — and while the mask SKIP in `refStateLookupFromResource` fired
    // unconditionally, the fall-through emitted the raw physical id and
    // `resolveImportedProperties` PERSISTED it into `resource.properties`.
    //
    // For a Cloud-Control-routed `AWS::Backup::BackupSelection` that id is the
    // compound `<SelectionId>_<BackupPlanId>` — a value CloudFormation's `Ref`
    // never returns. On `main` this persisted the real `SelectionId`; with the
    // unconditional skip it persisted a wrong value NOTHING recognises, so
    // `cdkd export` wrote it into the imported template and
    // `cdkd drift --revert` sent it to AWS (the #1498 / #1501 class). The
    // opt-in restores the pre-#2847 answer: the mask travels, and the four
    // readers that recognise it still refuse it.
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      stackName: 'attrs-stack',
      region: 'us-east-1',
      resources: {
        Sel: {
          physicalId: 'sel-2847_plan-2847',
          resourceType: 'AWS::Backup::BackupSelection',
          properties: {},
          // What `CloudControlProvider.import` writes with no
          // `cloudformation:DescribeType`: the whole model masked.
          attributes: { SelectionId: '***' },
        },
        Other: {
          physicalId: 'other-phys',
          resourceType: 'AWS::SQS::Queue',
          properties: { QueueName: { Ref: 'Sel' } },
        },
      },
      outputs: {},
      lastModified: 0,
    } satisfies StackState;

    await resolveImportedProperties(
      state,
      {
        Resources: {
          Sel: { Type: 'AWS::Backup::BackupSelection', Properties: {} },
          Other: { Type: 'AWS::SQS::Queue', Properties: { QueueName: { Ref: 'Sel' } } },
        },
      } as CloudFormationTemplate,
      'us-east-1',
      {} as never,
      getLogger()
    );

    // POSITIVE: the recognisable sentinel is what lands in state...
    expect(state.resources['Other']?.properties).toEqual({ QueueName: '***' });
    // ...and NEGATIVE: the compound physical id, which no reader tests for,
    // must not appear anywhere in the record.
    expect(JSON.stringify(state.resources['Other'])).not.toContain('sel-2847_plan-2847');
  });

  it('rewrites a decrypted secret AWS echoed into attributes back onto its expression', async () => {
    const state = stateWith(
      { Detail: { pw: TOKEN } },
      // What a provider's `import()` returns: the AWS readback, holding the
      // DECRYPTED value plus an ordinary non-secret attribute beside it.
      { QueueArn: 'arn:aws:sqs:us-east-1:111122223333:q', Password: PLAINTEXT }
    );

    await run(state);

    // POSITIVE and NEGATIVE together: `Password` is still PRESENT (dropping it
    // would degrade `Fn::GetAtt` to `constructAttribute`'s physical-id
    // fallback) and now holds the token; the innocent sibling is untouched.
    expect(state.resources['Res']?.attributes).toEqual({
      QueueArn: 'arn:aws:sqs:us-east-1:111122223333:q',
      Password: TOKEN,
    });
    expect(JSON.stringify(state.resources['Res'])).not.toContain(PLAINTEXT);
  });

  it('redacts on the THROW arm too — a resolve that recorded one needle before failing on the next', async () => {
    const state = stateWith(
      // The FIRST reference resolves and records `PLAINTEXT_2 -> TOKEN_2`; the
      // SECOND throws. The needle is in the bag by the time the throw lands,
      // which is the whole reason `recordedSecretValues` is hoisted above the
      // `try` in the walk.
      { Good: TOKEN_2, Bad: MISSING_TOKEN },
      { Password: PLAINTEXT_2 }
    );

    await run(state);

    // Placing the redaction AFTER the refusal's `continue` would leave this
    // bag in the clear — and the refusal fires on exactly this arm, so this
    // case is the one that discriminates the placement.
    expect(state.resources['Res']?.attributes).toEqual({ Password: TOKEN_2 });
    expect(JSON.stringify(state.resources['Res'])).not.toContain(PLAINTEXT_2);
  });

  it('leaves attributes untouched when the resource resolved no secret at all', async () => {
    const state = stateWith(
      { Detail: { name: 'plain' } },
      { QueueArn: 'arn:aws:sqs:us-east-1:111122223333:q', VisibilityTimeout: 30 }
    );

    await run(state);

    // The OTHER direction (issue #2027's rule): over-redaction on this path is
    // silent, so a fence that only proves "secrets get rewritten" would accept
    // an implementation that rewrote everything.
    expect(state.resources['Res']?.attributes).toEqual({
      QueueArn: 'arn:aws:sqs:us-east-1:111122223333:q',
      VisibilityTimeout: 30,
    });
  });

  it('tolerates a resource with no attributes bag at all', async () => {
    const state = stateWith({ Detail: { pw: TOKEN } }, undefined);

    await run(state);

    expect(state.resources['Res']?.attributes).toBeUndefined();
    // The `properties` redaction is unaffected — this case must not pass by
    // the walk having bailed out before doing its original job.
    expect(state.resources['Res']?.properties).toEqual({ Detail: { pw: TOKEN } });
  });
});
