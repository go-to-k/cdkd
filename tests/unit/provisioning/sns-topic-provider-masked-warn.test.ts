import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Issue #1997: `buildDeliveryStatusAttributeMap`'s warn arms interpolate a
// RESOLVED `DeliveryStatusLogging` value straight into `logger.warn`. cdkd's
// secret masking lives at the deploy engine (error / reason text) and the
// resolver's debug line only, so a `{{resolve:secretsmanager:...}}` scalar
// reaching one of those warnings printed in plaintext. The provider now masks
// through the `maskSecrets` capability its caller puts on `CreateContext` /
// `UpdateContext` (the contract issue #1932 item 3 added).

const mockSend = vi.fn();
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    }),
  };
});

import {
  SNSTopicProvider,
  buildDeliveryStatusAttributeMap,
} from '../../../src/provisioning/providers/sns-topic-provider.js';
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// Distinctive literals, grepped against the whole tree before being invented so
// they cannot coincide with another suite's assertion needle (which would make
// a `toContain` here pass for the wrong reason). Long enough to clear
// `MIN_NEEDLE_LENGTH` (4) so the message-level pass could reach them too —
// that is what makes the SHORT and ESCAPED cases below the discriminating ones.
const SECRET_PLAINTEXT = 'issue1997-sns-protocol-plaintext';
const SECRET_EXPR = '{{resolve:secretsmanager:sns/proto:SecretString:v::}}';

function secretBag(): RecordedSecretValues {
  return new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]);
}

function warnings(): string {
  return warn.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('SNSTopicProvider - resolved secrets in the DeliveryStatusLogging warnings (issue #1997)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The function-level arms, exercised directly because
  // `buildDeliveryStatusAttributeMap` is exported and each `onMalformed`
  // arm reaches a DIFFERENT `warn(...)` call. Driving them through `update()`
  // alone would leave three of the four sites covered only transitively.
  describe('buildDeliveryStatusAttributeMap', () => {
    it('masks a resolved secret in the non-array container warning', () => {
      buildDeliveryStatusAttributeMap(
        SECRET_PLAINTEXT,
        'MyTopic',
        'warn',
        createSecretMasker(secretBag())
      );

      const warned = warnings();
      // Non-vacuity: the warning DID fire, so the assertions below are about
      // masking rather than about an absent message.
      expect(warned).toContain('must be an array of');
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(warned).toContain(SECRET_MASK);
    });

    it('masks a resolved secret in the non-object entry warning', () => {
      buildDeliveryStatusAttributeMap(
        [SECRET_PLAINTEXT],
        'MyTopic',
        'warn',
        createSecretMasker(secretBag())
      );

      const warned = warnings();
      expect(warned).toContain('entries must be {Protocol, ...} objects');
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(warned).toContain(SECRET_MASK);
    });

    it('masks a resolved secret in the unsupported-protocol warning', () => {
      buildDeliveryStatusAttributeMap(
        [{ Protocol: SECRET_PLAINTEXT }],
        'MyTopic',
        'warn',
        createSecretMasker(secretBag())
      );

      const warned = warnings();
      expect(warned).toContain('unsupported protocol');
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(warned).toContain(SECRET_MASK);
    });

    // THE realistic secret shape, and the case a message-only mask cannot reach
    // at any length: `JSON.stringify` escapes `"` / `\` / newlines, so the
    // needle no longer OCCURS in the finished line and the sink's SUBSTRING
    // scan finds nothing. Deleting `maskLeaf` (the inner layer) while keeping
    // the sink leaves this the failing test.
    it('masks a secret that JSON escaping would otherwise hide', () => {
      const ESCAPED = 'a"b-issue1997-sns-escaped';
      const bag: RecordedSecretValues = new Map([
        [ESCAPED, '{{resolve:secretsmanager:sns/doc:SecretString:v::}}'],
      ]);

      buildDeliveryStatusAttributeMap([{ Protocol: ESCAPED }], 'MyTopic', 'warn', createSecretMasker(bag));

      const warned = warnings();
      expect(warned).toContain('unsupported protocol');
      // The ESCAPED rendering is the one that actually leaked, so asserting
      // only the raw form would pass on the broken code.
      expect(warned).not.toContain(ESCAPED);
      expect(warned).not.toContain(JSON.stringify(ESCAPED).slice(1, -1));
      expect(warned).toContain(SECRET_MASK);
    });

    // The needle floor, the other reason the leaf pass exists.
    // `maskSecretsInText` masks an exact WHOLE-VALUE match at ANY length but
    // only scans for SUBSTRING needles of >= MIN_NEEDLE_LENGTH (4), and a
    // finished message is always longer than the value inside it.
    it('masks a SHORT secret, which only the value-level pass can reach', () => {
      const SHORT = 'ab1';
      const bag: RecordedSecretValues = new Map([
        [SHORT, '{{resolve:secretsmanager:sns/pin:SecretString:v::}}'],
      ]);

      buildDeliveryStatusAttributeMap([{ Protocol: SHORT }], 'MyTopic', 'warn', createSecretMasker(bag));

      const warned = warnings();
      expect(warned).toContain('unsupported protocol');
      // Asserted as the QUOTED form so three characters cannot match
      // incidentally inside another word in the message.
      expect(warned).not.toContain(`"${SHORT}"`);
      expect(warned).toContain(`"${SECRET_MASK}"`);
    });

    // The SINK's own arm, and the reason both layers exist. `maskLeaf` walks
    // string leaves only — it returns a NUMBER unchanged, by design, since a
    // number cannot be handed to `maskSecretsInText`'s whole-value arm as a
    // needle. CloudFormation is stringly-AND-numerically typed, so a malformed
    // `Protocol` really can arrive as an unquoted number, and `JSON.stringify`
    // renders it WITHOUT quotes or escapes — which is exactly the shape the
    // message-level scan can still match. Reverting the sink to a bare
    // `logger.warn(message)` leaves this the only failing test; reverting
    // `maskLeaf` leaves the escaped / short cases above failing and this one
    // passing, so the two layers are fenced independently.
    it('masks a NUMERIC secret through the sink, which the leaf walk declines', () => {
      const NUMERIC = '86400';
      const bag: RecordedSecretValues = new Map([
        [NUMERIC, '{{resolve:secretsmanager:sns/num:SecretString:v::}}'],
      ]);

      buildDeliveryStatusAttributeMap(
        [{ Protocol: Number(NUMERIC) }],
        'MyTopic',
        'warn',
        createSecretMasker(bag)
      );

      const warned = warnings();
      expect(warned).toContain('unsupported protocol');
      expect(warned).not.toContain(NUMERIC);
      expect(warned).toContain(SECRET_MASK);
    });

    // The `'throw'` arm, which the first cut left unmasked on a rationale that
    // was FALSE: it claimed the deploy engine masks a thrown message, but the
    // engine masks `error.message` only on its EVENTS-STORE path — its CLI path
    // logs it raw. So an unmasked throw here printed the resolved bag straight
    // to the terminal, a worse exposure than the warn arms this change targets.
    it('masks a resolved secret in the non-array THROW arm', () => {
      expect(() =>
        buildDeliveryStatusAttributeMap(
          SECRET_PLAINTEXT,
          'MyTopic',
          'throw',
          createSecretMasker(secretBag())
        )
      ).toThrow(/must be an array of/);

      try {
        buildDeliveryStatusAttributeMap(
          SECRET_PLAINTEXT,
          'MyTopic',
          'throw',
          createSecretMasker(secretBag())
        );
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain(SECRET_PLAINTEXT);
        expect(message).toContain(SECRET_MASK);
      }
    });

    it('masks a resolved secret in the non-object ENTRY throw arm', () => {
      try {
        buildDeliveryStatusAttributeMap(
          [SECRET_PLAINTEXT],
          'MyTopic',
          'throw',
          createSecretMasker(secretBag())
        );
        throw new Error('expected a refusal');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain('entries must be');
        expect(message).not.toContain(SECRET_PLAINTEXT);
        expect(message).toContain(SECRET_MASK);
      }
    });

    // The THIRD throw site, in `normalizeDeliveryStatusProtocolOrThrow`, reached
    // from the same arm.
    it('masks a resolved secret in the unsupported-protocol throw arm', () => {
      try {
        buildDeliveryStatusAttributeMap(
          [{ Protocol: SECRET_PLAINTEXT }],
          'MyTopic',
          'throw',
          createSecretMasker(secretBag())
        );
        throw new Error('expected a refusal');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain('unsupported DeliveryStatusLogging protocol');
        expect(message).not.toContain(SECRET_PLAINTEXT);
        expect(message).toContain(SECRET_MASK);
      }
    });

    it('leaves the THROW arm unmasked when no masker is supplied', () => {
      try {
        buildDeliveryStatusAttributeMap(SECRET_PLAINTEXT, 'MyTopic', 'throw');
        throw new Error('expected a refusal');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain('must be an array of');
        expect(message).toContain(SECRET_PLAINTEXT);
      }
    });

    // Back-compat: the default is IDENTITY, so every caller that passes no
    // masker (the diff path, the import path, every pre-existing test) must be
    // byte-identical to before. This is what makes the contract optional rather
    // than a breaking interface change — and it also fences the opposite
    // failure, a "fix" that swallowed the value unconditionally.
    it('leaves the warning unmasked when no masker is supplied', () => {
      buildDeliveryStatusAttributeMap([{ Protocol: SECRET_PLAINTEXT }], 'MyTopic', 'warn');

      const warned = warnings();
      expect(warned).toContain('unsupported protocol');
      expect(warned).toContain(SECRET_PLAINTEXT);
      expect(warned).not.toContain(SECRET_MASK);
    });

    // A non-secret value must survive verbatim even WITH a masker, or the fix
    // would have bought confidentiality by destroying the warning's diagnostic
    // value.
    it('does not mangle a non-secret value when a masker IS supplied', () => {
      buildDeliveryStatusAttributeMap(
        [{ Protocol: 'definitely-not-a-protocol' }],
        'MyTopic',
        'warn',
        createSecretMasker(secretBag())
      );

      const warned = warnings();
      expect(warned).toContain('"definitely-not-a-protocol"');
      expect(warned).not.toContain(SECRET_MASK);
    });
  });

  // Both entry points, because the masker reaches the same function by two
  // different routes and a masker threaded on one alone leaves the fix
  // conditional on which path a given deploy takes.
  describe('provider entry points', () => {
    let provider: SNSTopicProvider;

    beforeEach(() => {
      provider = new SNSTopicProvider();
    });

    it('threads the masker from CreateContext through create()', async () => {
      mockSend.mockResolvedValue({ TopicArn: 'arn:aws:sns:us-east-1:0:issue1997-topic' });

      await provider.create(
        'MyTopic',
        'AWS::SNS::Topic',
        {
          TopicName: 'issue1997-topic',
          DeliveryStatusLogging: [{ Protocol: SECRET_PLAINTEXT }],
        },
        {
          // `replayingState` is load-bearing, not decoration: without it the
          // create path takes `'throw'` mode, which raises instead of warning,
          // and this test would assert nothing.
          replayingState: true,
          maskSecrets: createSecretMasker(secretBag()),
        }
      );

      const warned = warnings();
      expect(warned).toContain('unsupported protocol');
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(warned).toContain(SECRET_MASK);
    });

    it('threads the masker from UpdateContext through update()', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'MyTopic',
        'arn:aws:sns:us-east-1:0:issue1997-topic',
        'AWS::SNS::Topic',
        { DeliveryStatusLogging: [{ Protocol: SECRET_PLAINTEXT }] },
        { DeliveryStatusLogging: [] },
        { maskSecrets: createSecretMasker(secretBag()) }
      );

      const warned = warnings();
      expect(warned).toContain('unsupported protocol');
      expect(warned).not.toContain(SECRET_PLAINTEXT);
      expect(warned).toContain(SECRET_MASK);
    });

    it('leaves update() unmasked when the caller passes no context', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'MyTopic',
        'arn:aws:sns:us-east-1:0:issue1997-topic',
        'AWS::SNS::Topic',
        { DeliveryStatusLogging: [{ Protocol: SECRET_PLAINTEXT }] },
        { DeliveryStatusLogging: [] }
      );

      const warned = warnings();
      expect(warned).toContain('unsupported protocol');
      expect(warned).toContain(SECRET_PLAINTEXT);
    });

    // A context WITHOUT `maskSecrets` (a caller that only sets
    // `desiredFromAwsReadback`, or one written before the contract existed)
    // must not throw.
    it('does not throw for an update context that carries no masker', async () => {
      mockSend.mockResolvedValue({});

      await expect(
        provider.update(
          'MyTopic',
          'arn:aws:sns:us-east-1:0:issue1997-topic',
          'AWS::SNS::Topic',
          { DeliveryStatusLogging: [{ Protocol: SECRET_PLAINTEXT }] },
          { DeliveryStatusLogging: [] },
          { desiredFromAwsReadback: true }
        )
      ).resolves.toBeDefined();
      expect(warnings()).toContain('unsupported protocol');
    });
  });
});
