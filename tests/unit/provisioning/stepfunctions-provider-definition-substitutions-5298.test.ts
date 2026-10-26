import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#5298: `DefinitionSubstitutions` must be applied to the INLINE
 * definition forms (`DefinitionString` / `Definition`, string or object), not
 * only to the `DefinitionS3Location` body. aws-cdk-lib's `StateMachine` emits
 * `DefinitionString` plus a separate `DefinitionSubstitutions` map (never an
 * `Fn::Sub`), and CloudFormation substitutes into the inline body, so the
 * `${name}` placeholders reach the provider as plain text.
 */

const mockSend = vi.fn();
const mockS3Send = vi.fn();

vi.mock('@aws-sdk/client-sfn', async () => {
  const actual = await vi.importActual('@aws-sdk/client-sfn');
  return {
    ...actual,
    SFNClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { StepFunctionsProvider } from '../../../src/provisioning/providers/stepfunctions-provider.js';

const TYPE = 'AWS::StepFunctions::StateMachine';
const ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:sm';
const ROLE = 'arn:aws:iam::123456789012:role/sfn';
const TABLE = 'arn:aws:dynamodb:us-east-1:123456789012:table/T';

// The body aws-cdk-lib's ChainDefinitionBody renders for a Task whose
// resource is a `${TableArn}` placeholder, with a numeric placeholder too.
const INLINE_BODY =
  '{"StartAt":"Call","States":{"Call":{"Type":"Task","Resource":"${TableArn}","TimeoutSeconds":${Timeout},"End":true}}}';
const SUBSTITUTED_BODY = `{"StartAt":"Call","States":{"Call":{"Type":"Task","Resource":"${TABLE}","TimeoutSeconds":30,"End":true}}}`;
const SUBSTITUTIONS = { TableArn: TABLE, Timeout: 30 };

describe('StepFunctionsProvider DefinitionSubstitutions on inline definitions (issue #5298)', () => {
  let provider: StepFunctionsProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    mockS3Send.mockReset();
    provider = new StepFunctionsProvider();
  });

  const createDefinition = async (properties: Record<string, unknown>): Promise<string> => {
    mockSend.mockResolvedValueOnce({ stateMachineArn: ARN });
    mockSend.mockResolvedValueOnce({ revisionId: 'rev-1' });
    await provider.create('Sm', TYPE, { RoleArn: ROLE, ...properties });
    expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateStateMachineCommand');
    expect(mockS3Send).not.toHaveBeenCalled();
    return mockSend.mock.calls[0][0].input.definition as string;
  };

  it('create: substitutes into a string DefinitionString (the aws-cdk-lib StateMachine shape)', async () => {
    const def = await createDefinition({
      DefinitionString: INLINE_BODY,
      DefinitionSubstitutions: SUBSTITUTIONS,
    });
    expect(def).toBe(SUBSTITUTED_BODY);
  });

  it('create: substitutes into an object-form DefinitionString', async () => {
    const def = await createDefinition({
      DefinitionString: { StartAt: 'Greet', States: { Greet: { Type: 'Pass', Result: '${Greeting}', End: true } } },
      DefinitionSubstitutions: { Greeting: 'hi' },
    });
    expect(def).toBe('{"StartAt":"Greet","States":{"Greet":{"Type":"Pass","Result":"hi","End":true}}}');
  });

  it('create: substitutes into an object-form Definition', async () => {
    const def = await createDefinition({
      Definition: { StartAt: 'Greet', States: { Greet: { Type: 'Pass', Result: '${Greeting}', End: true } } },
      DefinitionSubstitutions: { Greeting: 'hi' },
    });
    expect(def).toBe('{"StartAt":"Greet","States":{"Greet":{"Type":"Pass","Result":"hi","End":true}}}');
  });

  it('create: substitutes into a string-form Definition', async () => {
    const def = await createDefinition({
      Definition: INLINE_BODY,
      DefinitionSubstitutions: SUBSTITUTIONS,
    });
    expect(def).toBe(SUBSTITUTED_BODY);
  });

  it('create: replaces every occurrence of a placeholder', async () => {
    const def = await createDefinition({
      DefinitionString: '{"A":"${X}","B":"${X}-${X}"}',
      DefinitionSubstitutions: { X: 'v' },
    });
    expect(def).toBe('{"A":"v","B":"v-v"}');
  });

  it('create: one pass -- an inserted value is never re-scanned, whatever the key order', async () => {
    // `A`'s value carries `${B}`; a key-by-key replace would expand it when `B`
    // comes after `A` in the map and leave it when `B` comes first.
    for (const subs of [
      { A: 'x-${B}', B: 'y' },
      { B: 'y', A: 'x-${B}' },
    ]) {
      mockSend.mockReset();
      const def = await createDefinition({ DefinitionString: '{"P":"${A}","Q":"${B}"}', DefinitionSubstitutions: subs });
      expect(def).toBe('{"P":"x-${B}","Q":"y"}');
    }
  });

  it('create: a token with no matching key, and replace-pattern text in a value, stay literal', async () => {
    const def = await createDefinition({
      DefinitionString: '{"P":"${Known}","Q":"${Unknown}","R":"${toString}"}',
      DefinitionSubstitutions: { Known: "a$&b$'c" },
    });
    expect(def).toBe('{"P":"a$&b$\'c","Q":"${Unknown}","R":"${toString}"}');
  });

  it('create: a stray unclosed ${ does not swallow the next real token', async () => {
    const def = await createDefinition({
      DefinitionString: '{"Comment":"a ${ b","Result":"${X}"}',
      DefinitionSubstitutions: { X: 'v' },
    });
    expect(def).toBe('{"Comment":"a ${ b","Result":"v"}');
  });

  it('create: an inline body without DefinitionSubstitutions is passed through verbatim', async () => {
    const def = await createDefinition({ DefinitionString: INLINE_BODY });
    expect(def).toBe(INLINE_BODY);
  });

  it('update: a change to DefinitionSubstitutions alone sends the re-substituted inline body', async () => {
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({ name: 'sm', revisionId: 'rev-2' });

    await provider.update(
      'Sm',
      ARN,
      TYPE,
      {
        RoleArn: ROLE,
        DefinitionString: INLINE_BODY,
        DefinitionSubstitutions: { TableArn: `${TABLE}-v2`, Timeout: 45 },
      },
      { RoleArn: ROLE, DefinitionString: INLINE_BODY, DefinitionSubstitutions: SUBSTITUTIONS }
    );

    const updateCall = mockSend.mock.calls[0][0];
    expect(updateCall.constructor.name).toBe('UpdateStateMachineCommand');
    expect(updateCall.input.definition).toBe(
      `{"StartAt":"Call","States":{"Call":{"Type":"Task","Resource":"${TABLE}-v2","TimeoutSeconds":45,"End":true}}}`
    );
  });
});
