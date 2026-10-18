import { describe, it, expect } from 'vite-plus/test';
import {
  redactForState,
  recordResolvedPair,
  isSameGenerationBag,
  markSameGenerationBag,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import {
  contradictProvenPublicExpression,
  recordProvenPublicExpression,
} from '../../../src/deployment/secret-redaction/mask-only.js';
import {
  recordAfterRollbackUpdate,
  recordedPropertiesAfterReplayCreate,
} from '../../../src/deployment/rollback-executor/replay-retry.js';
import { redactRollbackRecord } from '../../../src/deployment/rollback-executor/replay-secrets.js';
import type { ResourceState } from '../../../src/types/state.js';

// go-to-k/cdkd#5056: a 1-3 character secret embedded in a literal persisted in
// plaintext (1) beside a PUBLIC ssm token, and (2) in a rollback-restored
// record. Both repros are the issue's own.

const PIN = '{{resolve:secretsmanager:db-pin:SecretString:pin}}';
const HOST = '{{resolve:ssm:/db/host}}';
const PIN_VALUE = 'x9';
const HOST_VALUE = 'db.example.com';

function pass(hostValue: string = HOST_VALUE): RecordedSecretValues {
  const secrets: RecordedSecretValues = new Map();
  // What the resolver's seam records for the secret, and its public proof.
  secrets.set(PIN_VALUE, PIN);
  recordResolvedPair(secrets, PIN, PIN_VALUE);
  recordProvenPublicExpression(secrets, HOST, hostValue);
  return secrets;
}

const urlSource = `postgres://${HOST}:5432/?pin=${PIN}`;
const urlOf = (host: string, pin: string): string => `postgres://${host}:5432/?pin=${pin}`;

function persist(
  bag: string,
  source: string,
  secrets: RecordedSecretValues,
  generation: 'same-generation' | 'unproven'
): string {
  return (
    redactForState(
      { Url: bag },
      { provenance: 'template-derived', secrets, source: { Url: source }, generation }
    ) as { Url: string }
  ).Url;
}

const scan = (bag: string, secrets: RecordedSecretValues): string =>
  redactForState(bag, { provenance: 'value-scan', secrets });

describe('a sub-floor secret beside a public ssm token (template-derived)', () => {
  it('persists the secret span as its token and the public span resolved (issue repro)', () => {
    expect(persist(urlOf(HOST_VALUE, PIN_VALUE), urlSource, pass(), 'same-generation')).toBe(
      urlOf(HOST_VALUE, PIN)
    );
  });

  it('keeps the public token RESOLVED, as state holds a public reference (#1901)', () => {
    const out = persist(urlOf(HOST_VALUE, PIN_VALUE), urlSource, pass(), 'same-generation');
    expect(out).not.toContain(HOST);
  });

  it('needs the same-generation claim', () => {
    const secrets = pass();
    const bag = urlOf(HOST_VALUE, PIN_VALUE);
    expect(persist(bag, urlSource, secrets, 'unproven')).toBe(scan(bag, secrets));
  });

  it('positions the secret span when the public value EQUALS the secret', () => {
    // The public value stays in state either way (it is public config); a
    // refusal would add the secret's own span in plaintext beside it.
    const secrets = pass(PIN_VALUE);
    const bag = urlOf(PIN_VALUE, PIN_VALUE);
    expect(persist(bag, urlSource, secrets, 'same-generation')).toBe(urlOf(PIN_VALUE, PIN));
    expect(scan(bag, secrets)).toBe(bag);
  });

  it('positions the secret span when the public value CONTAINS the secret', () => {
    const host = `db-${PIN_VALUE}.example.com`;
    const secrets = pass(host);
    const bag = urlOf(host, PIN_VALUE);
    expect(persist(bag, urlSource, secrets, 'same-generation')).toBe(urlOf(host, PIN));
  });

  it('refuses an EMPTY public value', () => {
    const secrets = pass('');
    const bag = urlOf('', PIN_VALUE);
    expect(persist(bag, urlSource, secrets, 'same-generation')).toBe(scan(bag, secrets));
  });

  it('refuses a recorded plaintext that straddles literal text and a token', () => {
    // Only the literal-text check sees a needle crossing the span edge: the
    // returned spelling would carry `pin={{resolve` for the scan to rewrite.
    const secrets = pass();
    secrets.set('pin={{resolve', '{{resolve:secretsmanager:odd:SecretString:k}}');
    const bag = urlOf(HOST_VALUE, PIN_VALUE);
    expect(persist(bag, urlSource, secrets, 'same-generation')).toBe(scan(bag, secrets));
  });

  it('refuses a bag whose secret span holds ANOTHER plaintext sharing the survivor', () => {
    // Only the rendering check tells the token's own plaintext from another
    // one the map maps to the same survivor.
    const pin = 'LONGPINVALUE01';
    const sibling = '{{resolve:secretsmanager:db-pin:SecretString:pin::AWSCURRENT}}';
    const secrets: RecordedSecretValues = new Map();
    secrets.set(pin, PIN);
    recordResolvedPair(secrets, PIN, pin);
    secrets.set(pin, sibling);
    secrets.set('OTHERVALUE99', sibling);
    recordProvenPublicExpression(secrets, HOST, HOST_VALUE);
    const bag = urlOf(HOST_VALUE, 'OTHERVALUE99');
    const out = persist(bag, urlSource, secrets, 'same-generation');
    expect(out).toBe(scan(bag, secrets));
    expect(out).not.toBe(urlOf(HOST_VALUE, PIN));
  });

  it('refuses a public token with no proof, or a contradicted one', () => {
    const unproven: RecordedSecretValues = new Map([[PIN_VALUE, PIN]]);
    recordResolvedPair(unproven, PIN, PIN_VALUE);
    const bag = urlOf(HOST_VALUE, PIN_VALUE);
    expect(persist(bag, urlSource, unproven, 'same-generation')).toBe(scan(bag, unproven));
    const contradicted = pass();
    contradictProvenPublicExpression(contradicted, HOST);
    expect(persist(bag, urlSource, contradicted, 'same-generation')).toBe(
      scan(bag, contradicted)
    );
  });

  it('refuses a bag the source does not render to (a moved public value)', () => {
    const secrets = pass();
    const bag = urlOf('other.example.com', PIN_VALUE);
    expect(persist(bag, urlSource, secrets, 'same-generation')).toBe(scan(bag, secrets));
  });

  it('refuses a public value spelling a reference', () => {
    const secrets = pass('{{resolve:ssm:/other}}');
    const bag = urlOf('{{resolve:ssm:/other}}', PIN_VALUE);
    expect(persist(bag, urlSource, secrets, 'same-generation')).toBe(scan(bag, secrets));
  });

  it('keeps the scan answer when an interfering recorded needle sits in the leaf', () => {
    // A 4+ character secret recorded by this pass occurs inside the public
    // value: the scan rewrites it there, so the bound refuses the leaf.
    const secrets = pass('db.LONGSECRET.example.com');
    secrets.set('LONGSECRET', '{{resolve:secretsmanager:other:SecretString:k}}');
    const bag = urlOf('db.LONGSECRET.example.com', PIN_VALUE);
    const out = persist(bag, urlSource, secrets, 'same-generation');
    expect(out).toBe(scan(bag, secrets));
    expect(out).not.toContain('LONGSECRET');
  });

  it('writes a 4+ character secret as its OWN token beside a public one', () => {
    // A sibling resolving to the same plaintext holds the map's slot; the
    // value scan would write the sibling's spelling.
    const pin = 'LONGPINVALUE01';
    const sibling = '{{resolve:secretsmanager:db-pin:SecretString:pin::AWSCURRENT}}';
    const secrets: RecordedSecretValues = new Map();
    secrets.set(pin, PIN);
    recordResolvedPair(secrets, PIN, pin);
    secrets.set(pin, sibling);
    recordResolvedPair(secrets, sibling, pin);
    recordProvenPublicExpression(secrets, HOST, HOST_VALUE);
    expect(persist(urlOf(HOST_VALUE, pin), urlSource, secrets, 'same-generation')).toBe(
      urlOf(HOST_VALUE, PIN)
    );
  });
});

describe('a sub-floor secret in a rollback-restored record (state-derived)', () => {
  const journaled = { Url: `pin=${PIN};host=prod` };
  const restored = { Url: `pin=${PIN_VALUE};host=prod` };

  it('positions the span under the replay claim (issue repro)', () => {
    const out = redactForState(restored, {
      provenance: 'state-derived',
      secrets: pass(),
      source: journaled,
      generation: 'same-generation',
    });
    expect(out).toEqual(journaled);
  });

  it('leaves an unclaimed bag to the scan (an unmarked effectiveProperties)', () => {
    const secrets = pass();
    const out = redactForState(restored, {
      provenance: 'state-derived',
      secrets,
      source: journaled,
      generation: 'unproven',
    });
    expect(out).toEqual({ Url: scan(restored.Url, secrets) });
  });

  const record = (properties: Record<string, unknown>): ResourceState =>
    ({
      resourceType: 'AWS::CloudFormation::Stack',
      physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/child/1',
      properties,
      attributes: {},
    }) as unknown as ResourceState;

  it('the record builders carry a provider-marked bag mark onto their copy', () => {
    const marked = markSameGenerationBag({ ...restored });
    const updated = recordAfterRollbackUpdate(record(journaled), {
      physicalId: 'p',
      wasReplaced: false,
      effectiveProperties: marked,
    });
    expect(updated.properties).toEqual(restored);
    expect(updated.properties).not.toBe(marked);
    expect(isSameGenerationBag(updated.properties)).toBe(true);
    const created = recordedPropertiesAfterReplayCreate(record(journaled), {
      physicalId: 'p',
      effectiveProperties: marked,
    });
    expect(created).not.toBe(marked);
    expect(isSameGenerationBag(created)).toBe(true);
  });

  it('the record builders leave an unmarked bag unmarked', () => {
    const plain = { ...restored };
    const updated = recordAfterRollbackUpdate(record(journaled), {
      physicalId: 'p',
      wasReplaced: false,
      effectiveProperties: plain,
    });
    expect(isSameGenerationBag(updated.properties)).toBe(false);
    expect(
      isSameGenerationBag(
        recordedPropertiesAfterReplayCreate(record(journaled), {
          physicalId: 'p',
          effectiveProperties: plain,
        })
      )
    ).toBe(false);
  });

  it('redactRollbackRecord states the claim from the mark, end to end', () => {
    const secrets = pass();
    const markedOut = redactRollbackRecord(
      recordAfterRollbackUpdate(record(journaled), {
        physicalId: 'p',
        wasReplaced: false,
        effectiveProperties: markSameGenerationBag({ ...restored }),
      }),
      secrets,
      journaled,
      {}
    );
    expect(markedOut.properties).toEqual(journaled);
    const unmarkedOut = redactRollbackRecord(
      recordAfterRollbackUpdate(record(journaled), {
        physicalId: 'p',
        wasReplaced: false,
        effectiveProperties: { ...restored },
      }),
      secrets,
      journaled,
      {}
    );
    // The residual the deploy engine has for the same bag: not claimed.
    expect(unmarkedOut.properties).toEqual(restored);
  });
});
