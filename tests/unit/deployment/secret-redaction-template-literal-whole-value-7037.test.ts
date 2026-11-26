import { describe, it, expect } from 'vite-plus/test';
import {
  redactForState,
  recordResolvedPair,
  keepTemplateLiteralLeaves,
  scrubResourceRecord,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// go-to-k/cdkd#7037, the WHOLE-VALUE twin of #6303: an `rds.DatabaseInstance`
// with `engine: postgres` and generated credentials has a secret whose
// `username` is `postgres`, the same text as the template's plain literal
// `Engine: "postgres"`. The persist walk spelled that literal as the username
// reference, so the next in-place update read an Engine change and refused a
// stateful replacement.

const USERNAME =
  '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:123456789012:secret:DbSecret-abc:SecretString:username::}}';
const PASSWORD =
  '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:123456789012:secret:DbSecret-abc:SecretString:password::}}';
const PW = 's3cr3tPassw0rd';

function pass(): RecordedSecretValues {
  const secrets: RecordedSecretValues = new Map();
  secrets.set('postgres', USERNAME);
  recordResolvedPair(secrets, USERNAME, 'postgres');
  secrets.set(PW, PASSWORD);
  recordResolvedPair(secrets, PASSWORD, PW);
  return secrets;
}

const source = {
  Engine: 'postgres',
  MasterUsername: USERNAME,
  MasterUserPassword: PASSWORD,
  // An intrinsic over the reference: no plain literal at this position.
  Description: { 'Fn::Join': ['', [USERNAME]] },
  // A plain literal that is NOT the bag: the bag is not the template's text.
  ConnectionHint: 'db',
  // A password-equal literal the template itself spells: public text.
  PublicSample: PW,
  SecurityGroupNames: ['postgres', 'web'],
};
const resolved = {
  Engine: 'postgres',
  MasterUsername: 'postgres',
  MasterUserPassword: PW,
  Description: 'postgres',
  ConnectionHint: 'postgres',
  PublicSample: PW,
  SecurityGroupNames: ['postgres', 'web'],
};

describe('a template literal EQUAL to a recorded plaintext (#7037)', () => {
  for (const provenance of ['template-derived', 'template-sourced'] as const) {
    it(`${provenance}: the literal is kept, every secret-derived leaf still redacted`, () => {
      const out = redactForState(resolved, {
        provenance,
        secrets: pass(),
        source,
        generation: provenance === 'template-derived' ? 'same-generation' : 'unproven',
      }) as Record<string, unknown>;
      expect(out['Engine']).toBe('postgres');
      // A list is walked positionally only where the bag was resolved from the
      // source; a readback's may be reordered, so its leaves take the scan.
      expect(out['SecurityGroupNames']).toEqual(
        provenance === 'template-derived' ? ['postgres', 'web'] : [USERNAME, 'web']
      );
      expect(out['PublicSample']).toBe(PW);
      // The positions whose value came from the secret keep the reference.
      expect(out['MasterUsername']).toBe(USERNAME);
      expect(out['MasterUserPassword']).toBe(PASSWORD);
      expect(out['Description']).toBe(USERNAME);
      // A leaf equal to a secret where the template spells OTHER text is
      // secret-derived as far as the walk can tell: still redacted.
      expect(out['ConnectionHint']).toBe(USERNAME);
    });
  }

  it('the deploy persist walk keeps it in properties AND observedProperties', () => {
    const out = scrubResourceRecord(
      {
        properties: { Engine: 'postgres', MasterUsername: 'postgres', MasterUserPassword: PW },
        attributes: {},
        observedProperties: { Engine: 'postgres', MasterUsername: 'postgres' },
      },
      pass(),
      { Engine: 'postgres', MasterUsername: USERNAME, MasterUserPassword: PASSWORD }
    );
    expect(out.properties).toEqual({
      Engine: 'postgres',
      MasterUsername: USERNAME,
      MasterUserPassword: PASSWORD,
    });
    expect(out.observedProperties).toEqual({ Engine: 'postgres', MasterUsername: USERNAME });
  });

  it('a STATE source does not license the keep: its leaf may be a legacy plaintext', () => {
    const out = redactForState(
      { Password: PW },
      { provenance: 'state-readback', secrets: pass(), source: { Password: PW } }
    ) as Record<string, unknown>;
    expect(out['Password']).toBe(PASSWORD);
  });

  it('no source: the value scan still takes the whole value', () => {
    const out = redactForState(
      { Engine: 'postgres' },
      { provenance: 'value-scan', secrets: pass() }
    ) as Record<string, unknown>;
    expect(out['Engine']).toBe(USERNAME);
  });
});

describe('an Fn::Join / Fn::Sub of template text and references (#7037)', () => {
  const walk = (bag: string, src: unknown, provenance: 'template-derived' | 'state-readback') =>
    (
      redactForState(
        { L: bag },
        provenance === 'template-derived'
          ? { provenance, secrets: pass(), source: { L: src }, generation: 'same-generation' }
          : { provenance, secrets: pass(), source: { L: src } }
      ) as Record<string, unknown>
    )['L'];

  it('keeps the text, the reference parts stay references', () => {
    expect(walk('postgres:postgres', { 'Fn::Join': [':', ['postgres', USERNAME]] }, 'template-derived')).toBe(
      `postgres:${USERNAME}`
    );
    expect(walk(`postgres-${PW}`, { 'Fn::Sub': `postgres-${PASSWORD}` }, 'template-derived')).toBe(
      `postgres-${PASSWORD}`
    );
    expect(walk('postgres', { 'Fn::Join': ['', ['post', 'gres']] }, 'template-derived')).toBe('postgres');
  });

  it('a value-bearing part is never kept as text: a parameter, an attribute, a placeholder', () => {
    // The `Ref` / `GetAtt` / `${...}` part resolved to the PASSWORD: text the
    // template does not hold. The literal-rendering arm refuses it, and the
    // value scan redacts the password.
    for (const src of [
      { 'Fn::Join': ['-', ['postgres', { Ref: 'DbPassword' }]] },
      { 'Fn::Join': ['-', ['postgres', { 'Fn::GetAtt': ['Secret', 'Value'] }]] },
      { 'Fn::Sub': 'postgres-${DbPassword}' },
      { 'Fn::Sub': ['postgres-${X}', { X: { Ref: 'DbPassword' } }] },
    ]) {
      const out = walk(`postgres-${PW}`, src, 'template-derived');
      expect(out).not.toContain(PW);
    }
  });

  it('refuses where the rendering does not equal the bag, and from a STATE source', () => {
    // A token whose recorded plaintext is not what the bag holds there.
    expect(walk(`postgres:${PW}`, { 'Fn::Join': [':', ['postgres', USERNAME]] }, 'template-derived')).toBe(
      `${USERNAME}:${PASSWORD}`
    );
    expect(walk('postgres:postgres', { 'Fn::Join': [':', ['postgres', USERNAME]] }, 'state-readback')).not.toBe(
      `postgres:${USERNAME}`
    );
  });

  it('an Fn::If takes its literal branch only where no other branch could have produced the value', () => {
    expect(walk('postgres', { 'Fn::If': ['C', 'postgres', 'mysql'] }, 'template-derived')).toBe('postgres');
    // The other branch is a value (a `NoEcho` parameter): the literal would
    // confirm it. And a reference resolving to the same text: which branch ran
    // is unknown, so the literal is not persisted either.
    expect(walk('postgres', { 'Fn::If': ['C', { Ref: 'DbUser' }, 'postgres'] }, 'template-derived')).toBe(USERNAME);
    expect(walk('postgres', { 'Fn::If': ['C', USERNAME, 'postgres'] }, 'template-derived')).toBe(USERNAME);
    expect(
      walk('postgres', { 'Fn::If': ['C', 'postgres', { Ref: 'AWS::NoValue' }] }, 'template-derived')
    ).toBe('postgres');
  });

  it('a token no plaintext was recorded for is not trusted as text', () => {
    const other = '{{resolve:secretsmanager:other:SecretString:k::}}';
    expect(walk('postgres:zzz', { 'Fn::Join': [':', ['postgres', other]] }, 'template-derived')).not.toBe(
      `postgres:${other}`
    );
  });
});

describe('template text beside a value-bearing part (generated, #7037)', () => {
  // Every short value (one under MIN_NEEDLE_LENGTH) x every value-bearing gap
  // the deploy harness cannot resolve (an attribute, an import, a parameter).
  const values = ['postgres', 'admin', '1234', 'pg'];
  const gaps: Record<string, unknown> = {
    'Fn::GetAtt': { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] },
    'Fn::ImportValue': { 'Fn::ImportValue': 'shared-host' },
    'a template parameter': { Ref: 'DbHost' },
  };
  const secretsFor = (v: string): RecordedSecretValues => {
    const s: RecordedSecretValues = new Map([[v, USERNAME]]);
    recordResolvedPair(s, USERNAME, v);
    s.set(PW, PASSWORD);
    recordResolvedPair(s, PASSWORD, PW);
    return s;
  };
  const walk = (v: string, bag: string, src: unknown): unknown =>
    (
      redactForState(
        { L: bag },
        { provenance: 'template-derived', secrets: secretsFor(v), source: { L: src }, generation: 'same-generation' }
      ) as Record<string, unknown>
    )['L'];

  for (const v of values) {
    for (const [name, gap] of Object.entries(gaps)) {
      it(`${JSON.stringify(v)} beside ${name}: the text is kept, the gap as resolved`, () => {
        const src = { 'Fn::Join': ['', [`${v}ql://`, gap, `/${v}`]] };
        expect(walk(v, `${v}ql://db.example.com/${v}`, src)).toBe(`${v}ql://db.example.com/${v}`);
      });
      it(`${JSON.stringify(v)} beside ${name} and the reference: the reference part is redacted`, () => {
        const src = { 'Fn::Join': ['', [`${v}://`, USERNAME, '@', gap, `/${v}`]] };
        expect(walk(v, `${v}://${v}@db.example.com/${v}`, src)).toBe(
          `${v}://${USERNAME}@db.example.com/${v}`
        );
      });
      it(`${JSON.stringify(v)}: a ${name} gap that resolved to the password is never kept`, () => {
        const src = { 'Fn::Join': ['', [`${v}:`, gap]] };
        expect(walk(v, `${v}:${PW}`, src)).not.toContain(PW);
      });
    }
  }
});

describe('a record a pre-#7037 walk wrote, met by a re-positioning pass', () => {
  it('`cdkd scrub`: the whole-token record takes the template literal', () => {
    const out = redactForState(
      { Engine: USERNAME, MasterUsername: USERNAME },
      {
        provenance: 'template-sourced',
        secrets: pass(),
        source: { Engine: 'postgres', MasterUsername: USERNAME },
        generation: 'unproven',
      }
    ) as Record<string, unknown>;
    expect(out['Engine']).toBe('postgres');
    expect(out['MasterUsername']).toBe(USERNAME);
  });

  it('an EDITED literal is not repaired: the rendering must equal it', () => {
    const out = redactForState(
      { Engine: USERNAME },
      {
        provenance: 'template-sourced',
        secrets: pass(),
        source: { Engine: 'mysql' },
        generation: 'unproven',
      }
    ) as Record<string, unknown>;
    expect(out['Engine']).toBe(USERNAME);
  });

  it('a STATE source never copies a plaintext it holds onto a reference leaf', () => {
    // The record's own `properties` can hold a secret an older cdkd persisted
    // in plaintext; the observed walk positioned against it must not spread
    // that plaintext into the leaf that holds the reference.
    for (const provenance of ['state-readback', 'state-cross-generation'] as const) {
      const out = redactForState(
        { Password: PASSWORD },
        { provenance, secrets: pass(), source: { Password: PW } }
      ) as Record<string, unknown>;
      expect(out['Password']).toBe(PASSWORD);
    }
  });

  it("scrub's observed keep puts back a leaf equal to the template literal", () => {
    expect(
      keepTemplateLiteralLeaves(
        { Engine: USERNAME, MasterUsername: USERNAME },
        { Engine: 'postgres', MasterUsername: 'postgres' },
        { Engine: 'postgres', MasterUsername: USERNAME },
        pass()
      )
    ).toEqual({ Engine: 'postgres', MasterUsername: USERNAME });
  });

  it("scrub's observed keep renders a pre-fix whole-token leaf back to the literal", () => {
    expect(
      keepTemplateLiteralLeaves(
        { Engine: USERNAME, Other: USERNAME, Masked: '***' },
        { Engine: USERNAME, Other: USERNAME, Masked: USERNAME },
        // `Other`: the template spells a different literal, so no repair.
        { Engine: 'postgres', Other: 'mysql', Masked: 'postgres' },
        pass()
      )
    ).toEqual({ Engine: 'postgres', Other: USERNAME, Masked: '***' });
  });
});
