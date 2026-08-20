import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Issue #1997: `toSdkResponseParameters`'s undeliverable-entry warning
// interpolates a RESOLVED `ResponseParameters` `Destination` / `Source` straight
// into `logger.warn`. cdkd's secret masking lives at the deploy engine (error /
// reason text) and the resolver's debug line only, so a
// `{{resolve:secretsmanager:...}}` scalar reaching it printed in plaintext. The
// provider now masks through the `maskSecrets` capability its caller puts on
// `CreateContext` / `UpdateContext` (the contract issue #1932 item 3 added).

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-apigatewayv2', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    ApiGatewayV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const warned: string[] = [];

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((message: string) => {
      warned.push(message);
    }),
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

import { ApiGatewayV2Provider } from '../../../src/provisioning/providers/apigatewayv2-provider.js';
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// Grepped against the whole tree before being invented, so it cannot coincide
// with another suite's assertion needle. Long enough to clear
// `MIN_NEEDLE_LENGTH` (4), which is what makes the SHORT case below the one
// that discriminates the leaf pass from the message pass.
const SECRET_PLAINTEXT = 'issue1997-apigwv2-source-plaintext';
const SECRET_EXPR = '{{resolve:secretsmanager:apigw/src:SecretString:v::}}';

function secretBag(): RecordedSecretValues {
  return new Map([[SECRET_PLAINTEXT, SECRET_EXPR]]);
}

/**
 * A `ResponseParameters` block whose single entry cdkd cannot deliver, because
 * `Destination` is not a string. That is the arm that WARNS, and the warning
 * quotes both `Destination` and `Source` — so a fixture must place the secret
 * on the side under test rather than assuming one covers the other.
 */
function undeliverable(destination: unknown, source: unknown): Record<string, unknown> {
  return { '500': { ResponseParameters: [{ Destination: destination, Source: source }] } };
}

const log = (): string => warned.join('\n');

describe('ApiGatewayV2Provider - resolved secrets in the ResponseParameters warning (issue #1997)', () => {
  let provider: ApiGatewayV2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    warned.length = 0;
    provider = new ApiGatewayV2Provider();
    mockSend.mockResolvedValue({ IntegrationId: 'issue1997int' });
  });

  const CREATE_PROPS = (rp: Record<string, unknown>): Record<string, unknown> => ({
    ApiId: 'issue1997api',
    IntegrationType: 'HTTP_PROXY',
    IntegrationUri: 'https://example.com',
    ResponseParameters: rp,
  });

  describe('create', () => {
    // `Source` is the side the SDK would have delivered as a map VALUE, so a
    // secret there is the realistic shape.
    it('masks a resolved secret in the Source half of the warning', async () => {
      await provider.create(
        'MyIntegration',
        'AWS::ApiGatewayV2::Integration',
        CREATE_PROPS(undeliverable({ Ref: 'NotAString' }, SECRET_PLAINTEXT)),
        { maskSecrets: createSecretMasker(secretBag()) }
      );

      // Non-vacuity: the warning DID fire, so the assertions below are about
      // masking rather than about an absent message.
      expect(log()).toContain('cdkd cannot deliver');
      expect(log()).not.toContain(SECRET_PLAINTEXT);
      expect(log()).toContain(SECRET_MASK);
    });

    // `Destination` becomes a map KEY, and it is a SEPARATE interpolation from
    // `Source` — masking only one leaves the other leaking, which is exactly
    // what a single-sided test would miss.
    it('masks a resolved secret in the Destination half of the warning', async () => {
      await provider.create(
        'MyIntegration',
        'AWS::ApiGatewayV2::Integration',
        // Destination must be a NON-string to reach the warn arm at all, so the
        // secret is nested inside the object — which is also the case a
        // top-level `typeof v === 'string'` mask would miss.
        CREATE_PROPS(undeliverable({ Ref: SECRET_PLAINTEXT }, undefined)),
        { maskSecrets: createSecretMasker(secretBag()) }
      );

      expect(log()).toContain('cdkd cannot deliver');
      expect(log()).not.toContain(SECRET_PLAINTEXT);
      expect(log()).toContain(SECRET_MASK);
    });

    // Gap 5 (test review): the widening from a scalar-only `maskScalar` to a
    // recursive `maskLeaf` walk had NO test — reverting it left the suite green.
    // These two cases are the regression fence, and both were confirmed against
    // committed HEAD to print plaintext.
    //
    // This arm fires PRECISELY because `Destination` is not a string, so the
    // realistic shape is an unresolved intrinsic wrapping the value. A
    // scalar-only mask declines the object and prints `{"Ref":"..."}` verbatim.
    it('masks a secret NESTED inside a non-string Destination', async () => {
      const NESTED = 'issue1997-apigwv2-nested-plaintext';
      const bag: RecordedSecretValues = new Map([
        [NESTED, '{{resolve:secretsmanager:apigw/nested:SecretString:v::}}'],
      ]);

      await provider.create(
        'MyIntegration',
        'AWS::ApiGatewayV2::Integration',
        CREATE_PROPS(undeliverable({ Ref: NESTED }, 'x')),
        { maskSecrets: createSecretMasker(bag) }
      );

      expect(log()).toContain('cdkd cannot deliver');
      expect(log()).not.toContain(NESTED);
      expect(log()).toContain(SECRET_MASK);
    });

    // The same nesting with a secret carrying a `"`. This is the case NEITHER
    // layer caught before the widening: the scalar mask declined the object, and
    // `JSON.stringify` then escaped the quote so the sink's substring scan found
    // nothing either. Measured on committed HEAD: the escaped plaintext printed.
    it('masks a NESTED secret that JSON escaping would otherwise hide', async () => {
      const NESTED_ESCAPED = 'a"b-issue1997-apigwv2-nested';
      const bag: RecordedSecretValues = new Map([
        [NESTED_ESCAPED, '{{resolve:secretsmanager:apigw/nesteddoc:SecretString:v::}}'],
      ]);

      await provider.create(
        'MyIntegration',
        'AWS::ApiGatewayV2::Integration',
        CREATE_PROPS(undeliverable({ Ref: NESTED_ESCAPED }, 'x')),
        { maskSecrets: createSecretMasker(bag) }
      );

      expect(log()).toContain('cdkd cannot deliver');
      expect(log()).not.toContain(NESTED_ESCAPED);
      expect(log()).not.toContain(JSON.stringify(NESTED_ESCAPED).slice(1, -1));
      expect(log()).toContain(SECRET_MASK);
    });

    // A short secret nested one level down, so the walk is fenced below the
    // 4-character floor as well as above it.
    it('masks a SHORT secret nested inside a non-string Destination', async () => {
      const SHORT = 'zq7';
      const bag: RecordedSecretValues = new Map([
        [SHORT, '{{resolve:secretsmanager:apigw/nestedpin:SecretString:v::}}'],
      ]);

      await provider.create(
        'MyIntegration',
        'AWS::ApiGatewayV2::Integration',
        CREATE_PROPS(undeliverable({ Ref: SHORT }, 'x')),
        { maskSecrets: createSecretMasker(bag) }
      );

      expect(log()).toContain('cdkd cannot deliver');
      expect(log()).not.toContain(`"${SHORT}"`);
      expect(log()).toContain(`"${SECRET_MASK}"`);
    });

    // The status code is a user-authored map KEY, interpolated into the same
    // line. A LONG secret here is masked by the sink alone — a mutation probe
    // reverting `maskSecrets(statusCode)` to the raw value left the suite GREEN
    // — so the key mask is fenced at the length where the sink cannot help.
    // Three characters is not a contrived width for this position: an HTTP
    // status code IS three characters, and `MIN_NEEDLE_LENGTH` is 4, so the
    // message-level substring scan can never match one. The whole-value mask on
    // the key is the only thing that reaches it.
    it('masks a 3-character status-code key, which the sink cannot reach', async () => {
      const SHORT_CODE = '503';
      const bag: RecordedSecretValues = new Map([
        [SHORT_CODE, '{{resolve:secretsmanager:apigw/code:SecretString:v::}}'],
      ]);

      await provider.create(
        'MyIntegration',
        'AWS::ApiGatewayV2::Integration',
        CREATE_PROPS({
          [SHORT_CODE]: { ResponseParameters: [{ Destination: 42, Source: 'x' }] },
        }),
        { maskSecrets: createSecretMasker(bag) }
      );

      expect(log()).toContain('cdkd cannot deliver');
      // Asserted in the QUOTED position the message renders, so three digits
      // cannot match incidentally elsewhere in the line.
      expect(log()).not.toContain(`ResponseParameters['${SHORT_CODE}']`);
      expect(log()).toContain(`ResponseParameters['${SECRET_MASK}']`);
    });

    // The same key position with a LONG secret, which the sink DOES cover. Kept
    // beside the case above so the two layers are visibly distinct rather than
    // looking like a duplicate.
    it('masks a resolved secret in the status-code key', async () => {
      await provider.create(
        'MyIntegration',
        'AWS::ApiGatewayV2::Integration',
        CREATE_PROPS({
          [SECRET_PLAINTEXT]: { ResponseParameters: [{ Destination: 42, Source: 'x' }] },
        }),
        { maskSecrets: createSecretMasker(secretBag()) }
      );

      expect(log()).toContain('cdkd cannot deliver');
      expect(log()).not.toContain(SECRET_PLAINTEXT);
      expect(log()).toContain(SECRET_MASK);
    });

    // THE realistic secret shape, and the case a message-only mask cannot reach
    // at any length: `JSON.stringify` escapes `"` / `\` / newlines, so the
    // needle no longer OCCURS in the finished line and the sink's SUBSTRING scan
    // finds nothing. Removing `maskScalar` (the inner layer) while keeping the
    // sink leaves this the failing test.
    it('masks a secret that JSON escaping would otherwise hide', async () => {
      const ESCAPED = 'a"b-issue1997-apigwv2-escaped';
      const bag: RecordedSecretValues = new Map([
        [ESCAPED, '{{resolve:secretsmanager:apigw/doc:SecretString:v::}}'],
      ]);

      await provider.create(
        'MyIntegration',
        'AWS::ApiGatewayV2::Integration',
        CREATE_PROPS(undeliverable({ Ref: 'NotAString' }, ESCAPED)),
        { maskSecrets: createSecretMasker(bag) }
      );

      expect(log()).toContain('cdkd cannot deliver');
      // The ESCAPED rendering is what actually leaked, so asserting only the
      // raw form would pass on the broken code.
      expect(log()).not.toContain(ESCAPED);
      expect(log()).not.toContain(JSON.stringify(ESCAPED).slice(1, -1));
      expect(log()).toContain(SECRET_MASK);
    });

    // The needle floor: `maskSecretsInText` masks an exact WHOLE-VALUE match at
    // ANY length but only scans for SUBSTRING needles of >= 4 characters, and a
    // finished message is always longer than the value inside it.
    it('masks a SHORT secret, which only the value-level pass can reach', async () => {
      const SHORT = 'zq7';
      const bag: RecordedSecretValues = new Map([
        [SHORT, '{{resolve:secretsmanager:apigw/pin:SecretString:v::}}'],
      ]);

      await provider.create(
        'MyIntegration',
        'AWS::ApiGatewayV2::Integration',
        CREATE_PROPS(undeliverable({ Ref: 'NotAString' }, SHORT)),
        { maskSecrets: createSecretMasker(bag) }
      );

      expect(log()).toContain('cdkd cannot deliver');
      // Asserted as the QUOTED form so three characters cannot match
      // incidentally inside another word in the message.
      expect(log()).not.toContain(`"${SHORT}"`);
      expect(log()).toContain(`"${SECRET_MASK}"`);
    });

    // The SINK's own arm, and the reason both layers exist. `maskScalar` masks
    // string scalars only — it returns a NUMBER unchanged, by design, since a
    // number cannot be handed to `maskSecretsInText`'s whole-value arm as a
    // needle. A numeric `Source` is not a hypothetical here: this provider
    // deliberately COERCES one (`Source: 403` under the canonical
    // `overwrite:statuscode` destination is a legal template), and
    // `JSON.stringify` renders it WITHOUT quotes or escapes — exactly the shape
    // the message-level scan can still match. Reverting the sink to a bare
    // `this.logger.warn(message)` leaves this the only failing test; reverting
    // `maskScalar` leaves the escaped / short cases failing and this one
    // passing, so the two layers are fenced independently.
    it('masks a NUMERIC secret through the sink, which the scalar mask declines', async () => {
      const NUMERIC = '40399';
      const bag: RecordedSecretValues = new Map([
        [NUMERIC, '{{resolve:secretsmanager:apigw/num:SecretString:v::}}'],
      ]);

      await provider.create(
        'MyIntegration',
        'AWS::ApiGatewayV2::Integration',
        CREATE_PROPS(undeliverable({ Ref: 'NotAString' }, Number(NUMERIC))),
        { maskSecrets: createSecretMasker(bag) }
      );

      expect(log()).toContain('cdkd cannot deliver');
      expect(log()).not.toContain(NUMERIC);
      expect(log()).toContain(SECRET_MASK);
    });

    // Back-compat: absent means unmasked, which is what lets the contract be
    // optional. It also fences the opposite failure — a "fix" that swallowed
    // the value unconditionally.
    it('leaves the warning unmasked when the caller passes no context', async () => {
      await provider.create(
        'MyIntegration',
        'AWS::ApiGatewayV2::Integration',
        CREATE_PROPS(undeliverable({ Ref: 'NotAString' }, SECRET_PLAINTEXT))
      );

      expect(log()).toContain('cdkd cannot deliver');
      expect(log()).toContain(SECRET_PLAINTEXT);
      expect(log()).not.toContain(SECRET_MASK);
    });

    it('does not mangle a non-secret value when a masker IS supplied', async () => {
      await provider.create(
        'MyIntegration',
        'AWS::ApiGatewayV2::Integration',
        CREATE_PROPS(undeliverable({ Ref: 'NotAString' }, 'plain-public-value')),
        { maskSecrets: createSecretMasker(secretBag()) }
      );

      expect(log()).toContain('"plain-public-value"');
      expect(log()).not.toContain(SECRET_MASK);
    });

    // A context WITHOUT `maskSecrets` must not throw.
    it('does not throw for a context that carries no masker', async () => {
      await expect(
        provider.create(
          'MyIntegration',
          'AWS::ApiGatewayV2::Integration',
          CREATE_PROPS(undeliverable({ Ref: 'NotAString' }, SECRET_PLAINTEXT)),
          { replayingState: true }
        )
      ).resolves.toBeDefined();
      expect(log()).toContain('cdkd cannot deliver');
    });
  });

  describe('update', () => {
    // The twin. `update()` reaches the SAME `toSdkResponseParameters` warning
    // with the same resolved bag, so a masker on create alone leaves the fix
    // conditional on which path a given deploy happens to take.
    it('masks a resolved secret in the Source half of the warning', async () => {
      await provider.update(
        'MyIntegration',
        'issue1997int',
        'AWS::ApiGatewayV2::Integration',
        { ApiId: 'issue1997api', ResponseParameters: undeliverable({ Ref: 'X' }, SECRET_PLAINTEXT) },
        { ApiId: 'issue1997api' },
        { maskSecrets: createSecretMasker(secretBag()) }
      );

      expect(log()).toContain('cdkd cannot deliver');
      expect(log()).not.toContain(SECRET_PLAINTEXT);
      expect(log()).toContain(SECRET_MASK);
    });

    it('leaves the warning unmasked when the caller passes no context', async () => {
      await provider.update(
        'MyIntegration',
        'issue1997int',
        'AWS::ApiGatewayV2::Integration',
        { ApiId: 'issue1997api', ResponseParameters: undeliverable({ Ref: 'X' }, SECRET_PLAINTEXT) },
        { ApiId: 'issue1997api' }
      );

      expect(log()).toContain('cdkd cannot deliver');
      expect(log()).toContain(SECRET_PLAINTEXT);
    });
  });
});
