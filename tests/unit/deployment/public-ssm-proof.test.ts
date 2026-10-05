import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue [#2036](https://github.com/go-to-k/cdkd/issues/2036): the two WRITERS of
 * the per-bag public-ssm proof, against the REAL resolver and the real
 * `AwsClients`, with only the leaf `SSMClient` faked.
 *
 * - The resolver files a proof into the pass's bag when a plain `ssm` token's
 *   parameter answers `String` / `StringList` — on a fresh lookup AND on a
 *   cache hit — and files none for a `SecureString`, an unclassifiable type, or
 *   a producer-region guest's answer. This is what `cdkd drift` reads.
 * - `PublicSsmProver` (`cdkd state refresh-observed`, `cdkd import`) asks the
 *   same resolver on its comparison path, so `WithDecryption` is `false` on
 *   EVERY request, in the record's OWN region, and any error is no proof.
 *
 * The SDK fake records the region each sending client was BUILT with, which is
 * the discriminator for "which region answered". Responses are keyed per
 * (region, parameter name) — no `*Once` queue to leak.
 */

interface FakeSend {
  ctorRegion: string | undefined;
  region: string | undefined;
  command: string;
  input: { Name?: string; WithDecryption?: boolean };
}

const { responses, ssmSends, makeFakeClientClass } = vi.hoisted(() => {
  const responses = new Map<string, unknown>();
  const makeFakeClientClass = (sends: FakeSend[] | undefined): unknown =>
    class {
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
      async send(command: {
        input?: FakeSend['input'];
        constructor: { name: string };
      }): Promise<unknown> {
        let region: string | undefined;
        try {
          region = await this.config.region();
        } catch {
          region = undefined;
        }
        const input = command.input ?? {};
        sends?.push({ ctorRegion: this.ctorConfig.region, region, command: command.constructor.name, input });
        const response = responses.get(`${String(region)}|${String(input.Name)}`);
        if (response instanceof Error) throw response;
        if (response === undefined) {
          throw new Error(`no ssm response primed for ${String(region)}|${String(input.Name)}`);
        }
        return response;
      }
      destroy(): void {}
    };
  return { responses, ssmSends: [] as FakeSend[], makeFakeClientClass };
});

vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SSMClient: makeFakeClientClass(ssmSends) };
});
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, STSClient: makeFakeClientClass(undefined) };
});

import { AwsClients, setAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';
import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { PublicSsmProver } from '../../../src/deployment/public-ssm-proof.js';
import {
  clearRecordedSecretExpressions,
  provenPublicValue,
} from '../../../src/deployment/secret-redaction/mask-only.js';

const isProvenPublicExpression = (bag: RecordedSecretValues, expression: string): boolean =>
  provenPublicValue(bag, expression) !== undefined;
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

const HOME = 'us-east-1';
const PUBLIC_NAME = '/app/public-host';
const SECURE_NAME = '/app/secure-token';
const LIST_NAME = '/app/public-list';
const DENIED_NAME = '/app/denied';
const ODD_NAME = '/app/odd-type';
const PUBLIC = `{{resolve:ssm:${PUBLIC_NAME}}}`;
const SECURE = `{{resolve:ssm:${SECURE_NAME}}}`;
const LIST = `{{resolve:ssm:${LIST_NAME}}}`;
const DENIED = `{{resolve:ssm:${DENIED_NAME}}}`;
const ODD = `{{resolve:ssm:${ODD_NAME}}}`;

const prime = (region: string, name: string, response: unknown): void => {
  responses.set(`${region}|${name}`, response);
};

const debug = vi.fn<(message: string) => void>();

beforeEach(() => {
  responses.clear();
  ssmSends.length = 0;
  debug.mockReset();
  resetAccountInfoCache();
  setAwsClients(new AwsClients({ region: HOME }));
  prime(HOME, PUBLIC_NAME, { Parameter: { Value: 'db.public.internal', Type: 'String' } });
  prime(HOME, SECURE_NAME, { Parameter: { Value: 'AQICAH-ciphertext', Type: 'SecureString' } });
  prime(HOME, LIST_NAME, { Parameter: { Value: 'a,b', Type: 'StringList' } });
  prime(HOME, ODD_NAME, { Parameter: { Value: 'v' } });
  const denied = new Error('User is not authorized to perform ssm:GetParameter on /app/denied');
  denied.name = 'AccessDeniedException';
  prime(HOME, DENIED_NAME, denied);
});

afterEach(() => {
  resetAwsClients();
  resetAccountInfoCache();
});

describe('PublicSsmProver (refresh-observed / import)', () => {
  const loadEvidence = vi.fn<() => Promise<{ regions: string[]; complete: boolean }>>();
  const prover = (region = HOME, producerRegions: string[] = [], complete = true): PublicSsmProver => {
    loadEvidence.mockReset();
    loadEvidence.mockImplementation(async () => ({ regions: producerRegions, complete }));
    return new PublicSsmProver(region, loadEvidence, { debug });
  };

  it('proves a String parameter in a MIXED leaf, asking WITHOUT decryption in the record region', async () => {
    const bag = await prover().proofBagFor({ Url: `https://${PUBLIC}/x` });
    // The proof carries the VALUE the lookup returned: the reader compares it.
    expect(provenPublicValue(bag, PUBLIC)).toBe('db.public.internal');
    expect(bag.size).toBe(0);
    expect(ssmSends).toHaveLength(1);
    expect(ssmSends[0]!.input).toEqual({ Name: PUBLIC_NAME, WithDecryption: false });
    expect(ssmSends[0]!.region).toBe(HOME);
  });

  it('proves a StringList parameter (the resolver model calls both public)', async () => {
    const bag = await prover().proofBagFor({ L: `[${LIST}]` });
    expect(isProvenPublicExpression(bag, LIST)).toBe(true);
  });

  it('a SecureString is NO proof, and is asked about without decryption', async () => {
    const bag = await prover().proofBagFor({ Conn: `pw=${SECURE};` });
    expect(isProvenPublicExpression(bag, SECURE)).toBe(false);
    expect(ssmSends.map((s) => s.input.WithDecryption)).toEqual([false]);
  });

  it('an absent Type is NO proof', async () => {
    const bag = await prover().proofBagFor({ V: `x-${ODD}` });
    expect(isProvenPublicExpression(bag, ODD)).toBe(false);
    expect(ssmSends).toHaveLength(1);
  });

  it('an AccessDenied is NO proof, never throws, and logs ONE line that names no parameter', async () => {
    const p = prover();
    const first = await p.proofBagFor({ V: `x-${DENIED}` });
    const second = await p.proofBagFor({ W: `y-${DENIED}` });
    expect(isProvenPublicExpression(first, DENIED)).toBe(false);
    expect(isProvenPublicExpression(second, DENIED)).toBe(false);
    expect(debug).toHaveBeenCalledTimes(1);
    const line = debug.mock.calls[0]![0];
    expect(line).toContain('AccessDeniedException');
    expect(line).not.toContain(DENIED_NAME);
    expect(ssmSends).toHaveLength(1);
  });

  it('asks about a token ONCE however many records embed it, and proves each record bag', async () => {
    const p = prover();
    const [a, b] = await Promise.all([
      p.proofBagFor({ U: `a-${PUBLIC}` }),
      p.proofBagFor({ U: `b-${PUBLIC}` }),
    ]);
    expect(a).not.toBe(b);
    expect(isProvenPublicExpression(a, PUBLIC)).toBe(true);
    expect(isProvenPublicExpression(b, PUBLIC)).toBe(true);
    expect(ssmSends).toHaveLength(1);
  });

  it('asks nothing for a WHOLE-token leaf (position decides it, no proof is read)', async () => {
    const bag = await prover().proofBagFor({ V: PUBLIC, S: SECURE });
    expect(ssmSends).toHaveLength(0);
    expect(isProvenPublicExpression(bag, PUBLIC)).toBe(false);
  });

  it('asks nothing for a non-ssm or ssm-secure token', async () => {
    await prover().proofBagFor({
      V: `x-{{resolve:secretsmanager:app/db:SecretString:password}}-{{resolve:ssm-secure:${SECURE_NAME}}}`,
    });
    expect(ssmSends).toHaveLength(0);
  });

  it('asks nothing, and proves nothing, for a region-less name in a stack reading another region', async () => {
    const bag = await prover(HOME, ['eu-west-1']).proofBagFor({ U: `x-${PUBLIC}` });
    expect(ssmSends).toHaveLength(0);
    expect(isProvenPublicExpression(bag, PUBLIC)).toBe(false);
  });

  it('asks nothing, and proves nothing, for an ARN naming another region', async () => {
    const arn = `{{resolve:ssm:arn:aws:ssm:eu-west-1:123456789012:parameter${PUBLIC_NAME}}}`;
    const bag = await prover().proofBagFor({ U: `x-${arn}` });
    expect(ssmSends).toHaveLength(0);
    expect(isProvenPublicExpression(bag, arn)).toBe(false);
  });

  it('INCOMPLETE evidence: a region-less reference is not asked about and proves nothing', async () => {
    const bag = await prover(HOME, [], false).proofBagFor({ U: `x-${PUBLIC}` });
    expect(ssmSends).toHaveLength(0);
    expect(isProvenPublicExpression(bag, PUBLIC)).toBe(false);
  });

  it('INCOMPLETE evidence still proves a same-region ARN, which names its own region', async () => {
    const arnName = `arn:aws:ssm:${HOME}:123456789012:parameter${PUBLIC_NAME}`;
    const arn = `{{resolve:ssm:${arnName}}}`;
    prime(HOME, arnName, { Parameter: { Value: 'by-arn', Type: 'String' } });
    const bag = await prover(HOME, [], false).proofBagFor({ U: `x-${arn}` });
    expect(provenPublicValue(bag, arn)).toBe('by-arn');
  });

  it('loads the producer-region evidence ONCE, and only for a region-less token', async () => {
    const p = prover();
    const arnName = `arn:aws:ssm:${HOME}:123456789012:parameter${PUBLIC_NAME}`;
    prime(HOME, arnName, { Parameter: { Value: 'by-arn', Type: 'String' } });
    await p.proofBagFor({ U: `x-{{resolve:ssm:${arnName}}}`, W: PUBLIC });
    // An ARN names its own region and a whole token is never asked about.
    expect(loadEvidence).not.toHaveBeenCalled();
    await Promise.all([p.proofBagFor({ U: `a-${PUBLIC}` }), p.proofBagFor({ U: `b-${LIST}` })]);
    expect(loadEvidence).toHaveBeenCalledTimes(1);
  });

  it('evidence that REJECTS is incomplete: no region-less proof, and no throw', async () => {
    const p = new PublicSsmProver(HOME, () => Promise.reject(new Error('unreadable')), { debug });
    const bag = await p.proofBagFor({ U: `x-${PUBLIC}` });
    expect(ssmSends).toHaveLength(0);
    expect(isProvenPublicExpression(bag, PUBLIC)).toBe(false);
  });

  it('asks in the PROVER region, not the ambient clients region', async () => {
    prime('us-west-2', PUBLIC_NAME, { Parameter: { Value: 'west', Type: 'String' } });
    const bag = await prover('us-west-2').proofBagFor({ U: `x-${PUBLIC}` });
    expect(isProvenPublicExpression(bag, PUBLIC)).toBe(true);
    expect(ssmSends.map((s) => s.region)).toEqual(['us-west-2']);
  });
});

describe('the resolver files the per-bag proof (cdkd drift)', () => {
  const ctx = (bag: RecordedSecretValues, extra: Partial<ResolverContext> = {}): ResolverContext => ({
    template: { Resources: {} },
    resources: {},
    recordedSecretValues: bag,
    ...extra,
  });

  it('a fresh String lookup proves the token in THIS pass bag', async () => {
    const resolver = new IntrinsicFunctionResolver(HOME);
    const bag: RecordedSecretValues = new Map();
    await resolver.resolveDynamicReferences(`https://${PUBLIC}/x`, ctx(bag));
    expect(isProvenPublicExpression(bag, PUBLIC)).toBe(true);
    expect(bag.size).toBe(0);
  });

  it('a CACHE HIT proves the token in a later pass bag too', async () => {
    const resolver = new IntrinsicFunctionResolver(HOME);
    await resolver.resolveDynamicReferences(PUBLIC, ctx(new Map()));
    const later: RecordedSecretValues = new Map();
    await resolver.resolveDynamicReferences(`a-${PUBLIC}`, ctx(later));
    expect(ssmSends).toHaveLength(1);
    expect(provenPublicValue(later, PUBLIC)).toBe('db.public.internal');
  });

  it('a SecureString is recorded as a secret and proves nothing', async () => {
    prime(HOME, SECURE_NAME, { Parameter: { Value: 'decrypted', Type: 'SecureString' } });
    const resolver = new IntrinsicFunctionResolver(HOME);
    const bag: RecordedSecretValues = new Map();
    await resolver.resolveDynamicReferences(`pw=${SECURE}`, ctx(bag));
    expect(bag.get('decrypted')).toBe(SECURE);
    expect(isProvenPublicExpression(bag, SECURE)).toBe(false);
  });

  it('an unclassifiable Type proves nothing', async () => {
    const resolver = new IntrinsicFunctionResolver(HOME);
    const bag: RecordedSecretValues = new Map();
    await resolver.resolveDynamicReferences(`x-${ODD}`, ctx(bag));
    expect(isProvenPublicExpression(bag, ODD)).toBe(false);
  });

  it('a SecureString CACHE HIT files no proof, even with every other veto removed', async () => {
    prime(HOME, SECURE_NAME, { Parameter: { Value: 'decrypted', Type: 'SecureString' } });
    const resolver = new IntrinsicFunctionResolver(HOME);
    await resolver.resolveDynamicReferences(SECURE, ctx(new Map()));
    const later: RecordedSecretValues = new Map();
    await resolver.resolveDynamicReferences(`pw=${SECURE}`, ctx(later));
    expect(ssmSends).toHaveLength(1);
    // Strip the two vetoes that would hide a proof filed by mistake: the
    // bag's own secret pair and the process-wide verdict.
    later.clear();
    clearRecordedSecretExpressions();
    expect(isProvenPublicExpression(later, SECURE)).toBe(false);
  });

  it('a LATER SecureString answer in the same bag voids an earlier proof (comparison path)', async () => {
    const bag: RecordedSecretValues = new Map();
    await new IntrinsicFunctionResolver(HOME).resolveDynamicReferences(`a-${PUBLIC}`, ctx(bag));
    expect(isProvenPublicExpression(bag, PUBLIC)).toBe(true);
    // Retyped between two lookups, answered on the no-decryption path: nothing
    // is recorded into the bag there, so only the contradiction can void it.
    prime(HOME, PUBLIC_NAME, { Parameter: { Value: 'AQICAH-ciphertext', Type: 'SecureString' } });
    await new IntrinsicFunctionResolver(HOME).resolveDynamicReferences(
      `b-${PUBLIC}`,
      ctx(bag, { skipDynamicReferences: true })
    );
    expect(bag.size).toBe(0);
    // That lookup also pinned a process-wide SECRET verdict, which vetoes the
    // proof on its own; drop it so the assertion reads the CONTRADICTION alone.
    clearRecordedSecretExpressions();
    expect(isProvenPublicExpression(bag, PUBLIC)).toBe(false);
  });

  it('a LATER unclassifiable answer in the same bag voids an earlier proof', async () => {
    const bag: RecordedSecretValues = new Map();
    await new IntrinsicFunctionResolver(HOME).resolveDynamicReferences(`a-${PUBLIC}`, ctx(bag));
    prime(HOME, PUBLIC_NAME, { Parameter: { Value: 'v' } });
    await new IntrinsicFunctionResolver(HOME).resolveDynamicReferences(
      `b-${PUBLIC}`,
      ctx(bag, { skipDynamicReferences: true })
    );
    expect(isProvenPublicExpression(bag, PUBLIC)).toBe(false);
  });

  it('a producer-region GUEST answer (an ARN naming another region) proves nothing', async () => {
    const arnName = `arn:aws:ssm:eu-west-1:123456789012:parameter${PUBLIC_NAME}`;
    const arn = `{{resolve:ssm:${arnName}}}`;
    prime('eu-west-1', arnName, { Parameter: { Value: 'eu', Type: 'String' } });
    const resolver = new IntrinsicFunctionResolver(HOME);
    const bag: RecordedSecretValues = new Map();
    const out = await resolver.resolveDynamicReferences(`x-${arn}`, ctx(bag));
    expect(out).toBe('x-eu');
    expect(ssmSends.map((s) => s.region)).toEqual(['eu-west-1']);
    expect(isProvenPublicExpression(bag, arn)).toBe(false);
    // ...and the guest's CACHE HIT on a later pass files none either.
    const later: RecordedSecretValues = new Map();
    expect(await resolver.resolveDynamicReferences(`y-${arn}`, ctx(later))).toBe('y-eu');
    expect(ssmSends).toHaveLength(1);
    expect(isProvenPublicExpression(later, arn)).toBe(false);
  });
});
