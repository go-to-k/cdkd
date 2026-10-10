/**
 * The shared derived-name judge's state-side helpers (go-to-k/cdkd#3869):
 * the callback the CLI commands give their resolver contexts, the per-resource
 * printing bag `cdkd destroy` binds, and the print-only `secretNameSink` the
 * resolver records a command's reads into.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const logLines: string[] = [];
vi.mock('../../../src/utils/logger.js', () => {
  const push =
    (level: string) =>
    (...args: unknown[]): void =>
      void logLines.push(`${level} ${args.map(String).join(' ')}`);
  const fake = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    setLevel: (): void => {},
    child: (): unknown => fake,
  };
  return { getLogger: () => fake };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

const { IntrinsicFunctionResolver } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
const {
  journaledOrphanPrintingBag,
  maskEventTextWithBoundBags,
  secretNamePrintingBag,
  secretNamesReadBy,
  stateSecretNameNeedles,
} = await import(
  '../../../src/deployment/secret-name-needles.js'
);
const { hasMaskableValues, maskSecretsInText, recordLogOnlyValue } = await import(
  '../../../src/deployment/secret-redaction.js'
);
const { withPrintingSecrets } = await import('../../../src/deployment/resource-secrets-scope.js');
// Loaded once at module level: the engine module is large, and a first case
// importing it under load spends its own timeout on the import.
const { DeployEngine } = await import('../../../src/deployment/deploy-engine.js');

const REF = '{{resolve:secretsmanager:team:SecretString:user::}}';
const USER_ID = 'team-secret-user';

type Records = Parameters<typeof secretNamePrintingBag>[1];

const records = (): Records =>
  ({
    User: {
      physicalId: USER_ID,
      resourceType: 'AWS::IAM::User',
      properties: { UserName: REF },
      dependencies: [],
    },
    Key: {
      physicalId: 'AKIAEXAMPLEKEY',
      resourceType: 'AWS::IAM::AccessKey',
      properties: { UserName: USER_ID },
      dependencies: ['User'],
    },
    Plain: {
      physicalId: 'plain-bucket',
      resourceType: 'AWS::S3::Bucket',
      properties: { BucketName: 'plain-bucket' },
      dependencies: [],
    },
  }) as unknown as Records;

describe('stateSecretNameNeedles — the CLI commands’ callback', () => {
  it('judges a state record from its persisted reference, and nothing else', () => {
    const needles = stateSecretNameNeedles(records());
    expect([...(needles('User') ?? [])]).toContain(USER_ID);
    expect(needles('Plain')).toBeUndefined();
    expect(needles('Missing')).toBeUndefined();
  });
});

describe('secretNamesReadBy / secretNamePrintingBag — what a destroy masks', () => {
  it("a reader carries the secret-named sibling's needles it holds", () => {
    expect([...secretNamesReadBy('Key', records().Key, records())]).toContain(USER_ID);
    expect(secretNamesReadBy('Plain', records().Plain, records()).size).toBe(0);
  });

  it("each resource's bag masks its own name and what it read", () => {
    expect(maskSecretsInText(`Deleting user ${USER_ID}`, secretNamePrintingBag('User', records()))).toBe(
      'Deleting user ***'
    );
    expect(
      maskSecretsInText(
        `Access key of ${USER_ID} deleted`,
        secretNamePrintingBag('Key', records())
      )
    ).toBe('Access key of *** deleted');
    // An ordinary resource binds nothing to mask.
    expect(hasMaskableValues(secretNamePrintingBag('Plain', records()))).toBe(false);
  });
});

describe('ResolverContext.secretNameSink — a command’s print-only sink', () => {
  beforeEach(() => {
    logLines.length = 0;
  });

  it('records there, never into the pass bag or printingSecrets, and masks the line', async () => {
    const recordedSecretValues = new Map<string, string>();
    const printingSecrets = new Map<string, string>();
    const sink = new Map<string, string>();
    const resources = records();
    const value = await new IntrinsicFunctionResolver().resolve(
      { Ref: 'User' },
      {
        template: { Resources: {} },
        resources,
        recordedSecretValues,
        printingSecrets,
        secretNameNeedles: stateSecretNameNeedles(resources),
        secretNameSink: sink,
      } as never
    );
    expect(value).toBe(USER_ID);
    expect(hasMaskableValues(recordedSecretValues)).toBe(false);
    expect(hasMaskableValues(printingSecrets)).toBe(false);
    expect(maskSecretsInText(USER_ID, sink)).toBe('***');
    expect(logLines.join('\n')).toContain('resolved to');
    expect(logLines.join('\n')).not.toContain(USER_ID);
  });

  function sinkContext(recordedSecretValues = new Map<string, string>()) {
    const resources = records();
    const sink = new Map<string, string>();
    return {
      sink,
      recordedSecretValues,
      context: {
        template: { Resources: {} },
        resources,
        recordedSecretValues,
        secretNameNeedles: stateSecretNameNeedles(resources),
        secretNameSink: sink,
      } as never,
    };
  }

  it('an Fn::Base64 encoding of text embedding the name is a sink needle too', async () => {
    // The CDK `UserData` shape: an encoding that decodes straight back to it.
    const { sink, context } = sinkContext();
    const encoded = (await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Base64': { 'Fn::Sub': 'q=${User}' } },
      context
    )) as string;
    expect(Buffer.from(encoded, 'base64').toString()).toBe(`q=${USER_ID}`);
    expect(maskSecretsInText(encoded, sink)).toBe('***');
    expect(logLines.join('\n')).toContain('Resolved Fn::Base64');
    expect(logLines.join('\n')).not.toContain(encoded);
  });

  it('a piece of the name, split and selected, is masked on every line', async () => {
    const { context } = sinkContext();
    const piece = await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Select': [1, { 'Fn::Split': ['-', { Ref: 'User' }] }] },
      context
    );
    expect(piece).toBe('secret');
    expect(logLines.join('\n')).toContain('Resolved Fn::Select');
    expect(logLines.join('\n')).not.toMatch(/\bsecret\b/);
  });

  it("the pass's own bag stays free of the encoding, even holding another log-only needle", async () => {
    // A pass bag with an unrelated log-only needle (`cdkd diff`'s `NoEcho`
    // values) takes the log-only carry; only the sink may hold the name's.
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, 'unrelated-noecho-value');
    const { context } = sinkContext(bag);
    const encoded = (await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Base64': { Ref: 'User' } },
      context
    )) as string;
    expect(maskSecretsInText(encoded, bag)).toBe(encoded);
  });

  it('the sink stays free of an encoding the printing bag alone masks', async () => {
    // The sink arm compares the masks WITH and WITHOUT the sink, both over the
    // printing bag: an encoding of a `NoEcho` value belongs to that bag only.
    const printing = new Map<string, string>();
    recordLogOnlyValue(printing, 'printing-only-noecho-value');
    const { sink, context } = sinkContext();
    recordLogOnlyValue(sink, 'unrelated-sink-needle');
    (context as { printingSecrets?: Map<string, string> }).printingSecrets = printing;
    const encoded = (await new IntrinsicFunctionResolver().resolve(
      { 'Fn::Base64': 'pw=printing-only-noecho-value' },
      context
    )) as string;
    // Premise: the printing arm took it.
    expect(maskSecretsInText(encoded, printing)).toBe('***');
    expect(maskSecretsInText(encoded, sink)).toBe(encoded);
  });
});

describe('journaledOrphanPrintingBag (go-to-k/cdkd#3869)', () => {
  const user = (userName: string): Records[string] => ({
    physicalId: USER_ID,
    resourceType: 'AWS::IAM::User',
    properties: { UserName: userName },
    attributes: {},
    dependencies: [],
  });
  const userOp = (userName: string) => ({
    logicalId: 'User',
    resourceType: 'AWS::IAM::User',
    physicalId: USER_ID,
    attemptedProperties: { UserName: userName },
  });
  const keyOp = {
    logicalId: 'Key',
    resourceType: 'AWS::IAM::AccessKey',
    physicalId: 'AKIAEXAMPLEKEY',
    attemptedProperties: { UserName: USER_ID },
  };
  const masks = (bag: Map<string, string>): boolean =>
    maskSecretsInText(`user ${USER_ID}`, bag) === 'user ***';

  it.each([
    ['its own entry names it from a secret', REF, true],
    ['negative control, an ordinary name', 'plain-user-name', false],
  ])("judges an orphan from its own journal entry: %s", (_l, name, masked) => {
    expect(masks(journaledOrphanPrintingBag([userOp(name)], {}))).toBe(masked);
  });

  it.each([
    ['a secret-named user in state', REF, true],
    ['negative control, an ordinary user', 'plain-user-name', false],
  ])('carries a name an orphan read from a state record: %s', (_l, name, masked) => {
    expect(masks(journaledOrphanPrintingBag([keyOp], { User: user(name) }))).toBe(masked);
  });

  it.each([
    ['a secret-named record', REF, true],
    ['negative control, an ordinary record', 'plain-user-name', false],
  ])("masks the state record under the orphan's own logical id: %s", (_l, name, masked) => {
    // A replacement orphan: the record is the resource being replaced.
    const op = { ...userOp('plain-new-name'), physicalId: 'new-user-id' };
    expect(masks(journaledOrphanPrintingBag([op], { User: user(name) }))).toBe(masked);
  });
});

describe('maskEventTextWithBoundBags (go-to-k/cdkd#3869)', () => {
  const event = (ownLines?: boolean) => ({
    eventType: 'RESOURCE_FAILED',
    physicalId: USER_ID,
    reason: `skipped ${USER_ID}`,
    error: { message: `AccessDenied on ${USER_ID}`, ...(ownLines !== undefined && { ownLines }) },
  });
  const bound = <T>(fn: () => T): T => {
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, USER_ID);
    return withPrintingSecrets(bag, fn);
  };

  it("masks the message and the reason under a bound bag, never the physicalId field", () => {
    const masked = bound(() => maskEventTextWithBoundBags(event()));
    expect(masked.error.message).toBe('AccessDenied on ***');
    expect(masked.reason).toBe('skipped ***');
    expect(masked.physicalId).toBe(USER_ID);
  });

  it('negative control: unchanged with no bag bound', () => {
    expect(maskEventTextWithBoundBags(event())).toEqual(event());
  });

  it("masks a replay refusal's own message (ownLines) line by line, but not its command line", () => {
    const own = {
      ...event(true),
      error: {
        // The command line's id is a vetted logical id; here it collides
        // with a needle, which must not cut the pasteable command.
        message: `Cannot reverse the replacement of 'Q' (it read ${USER_ID})\nTo orphan it: cdkd rollback S --orphan ${USER_ID}`,
        ownLines: true as const,
      },
    };
    const masked = bound(() => maskEventTextWithBoundBags(own));
    expect(masked.error.message).toBe(
      `Cannot reverse the replacement of 'Q' (it read ***)\nTo orphan it: cdkd rollback S --orphan ${USER_ID}`
    );
  });
});

describe('DeployEngine.recordEvent under a bound printing bag (go-to-k/cdkd#3869)', () => {
  // A nested child's engine records its events under the parent row's
  // derived-name registry (`withPrintingSecrets`); its own
  // `printingSecretsFor` holds none of those needles, so `deployments/*.jsonl`
  // kept a child AWS error quoting a parent-passed secret-named value.
  const engineRecording = async (events: Array<Record<string, unknown>>): Promise<{
    recordEvent: (event: Record<string, unknown>) => void;
  }> => {
    return new DeployEngine(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { getProvider: vi.fn(), getProviderFor: vi.fn() } as never,
      { dryRun: false, eventRecorder: { record: (e: Record<string, unknown>) => void events.push(e) } } as never,
      'us-east-1'
    ) as never;
  };
  const failed = () => ({
    eventType: 'RESOURCE_FAILED',
    logicalId: 'ChildParam',
    physicalId: USER_ID,
    reason: `create failed for ${USER_ID}`,
    error: { message: `Value '${USER_ID}' at 'value' failed to satisfy constraint` },
  });

  it.each([
    ['a bound needle masks the persisted text, never the physicalId field', true],
    ['negative control: nothing bound leaves it as written', false],
  ])('%s', async (_label, bind) => {
    const events: Array<Record<string, unknown>> = [];
    const engine = await engineRecording(events);
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, USER_ID);
    if (bind) withPrintingSecrets(bag, () => engine.recordEvent(failed()));
    else engine.recordEvent(failed());
    expect(events).toHaveLength(1);
    const [recorded] = events as Array<ReturnType<typeof failed>>;
    expect(recorded!.physicalId).toBe(USER_ID);
    if (bind) {
      expect(recorded!.error.message).toBe("Value '***' at 'value' failed to satisfy constraint");
      expect(recorded!.reason).toBe('create failed for ***');
    } else {
      expect(recorded).toEqual(failed());
    }
  });

  describe('one pass over the engine bag and the bound bags', () => {
    // The engine's own bag holds a NoEcho value the derived name embeds.
    const ENGINE = 'teamsecret';
    const DERIVED = 'q-teamsecret-queue';
    const engineWith = async (events: Array<Record<string, unknown>>) => {
      const engine = await engineRecording(events);
      const own = new Map<string, string>();
      recordLogOnlyValue(own, ENGINE);
      (engine as unknown as { perResourceSecrets: Map<string, unknown> }).perResourceSecrets.set(
        'ChildParam',
        own
      );
      return engine;
    };
    const boundBag = () => {
      const bag = new Map<string, string>();
      recordLogOnlyValue(bag, DERIVED);
      recordLogOnlyValue(bag, 'boundonly');
      return bag;
    };

    it('masks a derived needle that embeds an engine needle whole, leaving no fragment', async () => {
      const events: Array<Record<string, unknown>> = [];
      const engine = await engineWith(events);
      withPrintingSecrets(boundBag(), () =>
        engine.recordEvent({
          eventType: 'RESOURCE_FAILED',
          logicalId: 'ChildParam',
          reason: `create failed for ${DERIVED}`,
          error: { message: `queue ${DERIVED} rejected ${ENGINE}` },
        })
      );
      const [recorded] = events as Array<{ reason: string; error: { message: string } }>;
      expect(recorded!.reason).toBe('create failed for ***');
      expect(recorded!.error.message).toBe('queue *** rejected ***');
    });

    it("keeps an own-remedy command line masked by the engine bag, and only by it", async () => {
      const events: Array<Record<string, unknown>> = [];
      const engine = await engineWith(events);
      withPrintingSecrets(boundBag(), () =>
        engine.recordEvent({
          eventType: 'RESOURCE_FAILED',
          logicalId: 'ChildParam',
          error: {
            message:
              `Cannot reverse 'Q' (it read ${DERIVED}, boundonly)\n` +
              `To orphan it: cdkd rollback S --orphan Q -c k=${ENGINE} -c b=boundonly`,
            ownLines: true,
          },
        } as never)
      );
      const [recorded] = events as Array<{ error: { message: string } }>;
      expect(recorded!.error.message).toBe(
        "Cannot reverse 'Q' (it read ***, ***)\nTo orphan it: cdkd rollback S --orphan Q -c k=*** -c b=boundonly"
      );
    });

    it('masks an engine needle and a bound needle that overlap as one span, leaving neither tail', async () => {
      // B (bound) starts before A (engine); neither contains the other.
      const events: Array<Record<string, unknown>> = [];
      const engine = await engineRecording(events);
      const own = new Map<string, string>();
      recordLogOnlyValue(own, 'cdefgh-tail');
      (engine as unknown as { perResourceSecrets: Map<string, unknown> }).perResourceSecrets.set(
        'ChildParam',
        own
      );
      const bag = new Map<string, string>();
      recordLogOnlyValue(bag, 'xxab-cdefgh');
      withPrintingSecrets(bag, () =>
        engine.recordEvent({
          eventType: 'RESOURCE_FAILED',
          logicalId: 'ChildParam',
          reason: 'got xxab-cdefgh-tail back',
        })
      );
      expect((events[0] as { reason: string }).reason).toBe('got *** back');
    });

    it('masks a MULTI-LINE engine needle inside an own-remedy message, as one span', async () => {
      // A PEM-shaped value: the needle spans lines, so a per-line pass misses it.
      const pem = 'BEGIN-KEY\nsecret-body-line\nEND-KEY';
      const events: Array<Record<string, unknown>> = [];
      const engine = await engineRecording(events);
      const own = new Map<string, string>();
      recordLogOnlyValue(own, pem);
      (engine as unknown as { perResourceSecrets: Map<string, unknown> }).perResourceSecrets.set(
        'ChildParam',
        own
      );
      withPrintingSecrets(boundBag(), () =>
        engine.recordEvent({
          eventType: 'RESOURCE_FAILED',
          logicalId: 'ChildParam',
          error: {
            message: `Cannot reverse 'Q': value ${pem} rejected\nTo orphan it: cdkd rollback S --orphan Q`,
            ownLines: true,
          },
        } as never)
      );
      expect((events[0] as { error: { message: string } }).error.message).toBe(
        "Cannot reverse 'Q': value *** rejected\nTo orphan it: cdkd rollback S --orphan Q"
      );
    });

    it('masks a whole line that IS a short needle inside a multi-line own-remedy run', async () => {
      // Under the substring floor, a needle masks only a text it equals: the
      // line, not the joined run.
      const events: Array<Record<string, unknown>> = [];
      const engine = await engineRecording(events);
      const own = new Map<string, string>();
      recordLogOnlyValue(own, 'abc');
      (engine as unknown as { perResourceSecrets: Map<string, unknown> }).perResourceSecrets.set(
        'ChildParam',
        own
      );
      withPrintingSecrets(boundBag(), () =>
        engine.recordEvent({
          eventType: 'RESOURCE_FAILED',
          logicalId: 'ChildParam',
          error: {
            message: "Cannot reverse 'Q', it read:\nabc\nTo orphan it: cdkd rollback S --orphan Q",
            ownLines: true,
          },
        } as never)
      );
      expect((events[0] as { error: { message: string } }).error.message).toBe(
        "Cannot reverse 'Q', it read:\n***\nTo orphan it: cdkd rollback S --orphan Q"
      );
    });

    it('masks every line of a multi-line needle whose middle line is a needle on its own', async () => {
      const multi = 'BEGIN-KEY\nkey-body\nEND-KEY';
      const events: Array<Record<string, unknown>> = [];
      const engine = await engineRecording(events);
      const own = new Map<string, string>();
      recordLogOnlyValue(own, multi);
      recordLogOnlyValue(own, 'key-body');
      (engine as unknown as { perResourceSecrets: Map<string, unknown> }).perResourceSecrets.set(
        'ChildParam',
        own
      );
      withPrintingSecrets(boundBag(), () =>
        engine.recordEvent({
          eventType: 'RESOURCE_FAILED',
          logicalId: 'ChildParam',
          error: {
            message: `Cannot reverse 'Q':\n${multi}\nTo orphan it: cdkd rollback S --orphan Q`,
            ownLines: true,
          },
        } as never)
      );
      expect((events[0] as { error: { message: string } }).error.message).toBe(
        "Cannot reverse 'Q':\n***\nTo orphan it: cdkd rollback S --orphan Q"
      );
    });
  });
});
