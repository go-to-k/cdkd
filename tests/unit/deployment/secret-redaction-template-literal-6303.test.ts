import { describe, it, expect } from 'vite-plus/test';
import {
  redactForState,
  recordResolvedPair,
  keepTemplateLiteralLeaves,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { redactRollbackRecord } from '../../../src/deployment/rollback-executor/replay-secrets.js';

// go-to-k/cdkd#6303: CDK's generated Aurora username `postgres` is a recorded
// plaintext, and the value scan rewrote it inside the template's own literal
// `aurora-postgresql`, so the next deploy planned to REPLACE the cluster.

const USERNAME = '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:123456789012:secret:DbSecret-abc:SecretString:username::}}';
const PASSWORD = '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:123456789012:secret:DbSecret-abc:SecretString:password::}}';
const MANGLED_ENGINE = `aurora-${USERNAME}ql`;

function pass(): RecordedSecretValues {
  const secrets: RecordedSecretValues = new Map();
  secrets.set('postgres', USERNAME);
  recordResolvedPair(secrets, USERNAME, 'postgres');
  secrets.set('s3cr3tPassw0rd', PASSWORD);
  recordResolvedPair(secrets, PASSWORD, 's3cr3tPassw0rd');
  return secrets;
}

const source = {
  Engine: 'aurora-postgresql',
  DBClusterParameterGroupName: 'default.aurora-postgresql16',
  MasterUsername: USERNAME,
  MasterUserPassword: PASSWORD,
  Description: { 'Fn::Join': ['', ['owner=', USERNAME]] },
  ConnectionHint: 'jdbc://db',
};
const resolved = {
  Engine: 'aurora-postgresql',
  DBClusterParameterGroupName: 'default.aurora-postgresql16',
  MasterUsername: 'postgres',
  MasterUserPassword: 's3cr3tPassw0rd',
  Description: 'owner=postgres',
  ConnectionHint: 'jdbc://postgres',
};

describe('a recorded plaintext inside the source\'s own plain literal (#6303)', () => {
  for (const provenance of ['template-derived', 'template-sourced'] as const) {
    it(`${provenance}: the literal is kept, every secret position still redacted`, () => {
      const out = redactForState(resolved, {
        provenance,
        secrets: pass(),
        source,
        generation: provenance === 'template-derived' ? 'same-generation' : 'unproven',
      }) as Record<string, unknown>;
      expect(out['Engine']).toBe('aurora-postgresql');
      expect(out['DBClusterParameterGroupName']).toBe('default.aurora-postgresql16');
      expect(out['MasterUsername']).toBe(USERNAME);
      expect(out['MasterUserPassword']).toBe(PASSWORD);
      // The other polarity: a leaf the source does NOT spell as this literal
      // still takes the value scan. An intrinsic assembling the secret...
      expect(out['Description']).toBe(`owner=${USERNAME}`);
      // ...and a bag that differs from its literal source.
      expect(out['ConnectionHint']).toBe(`jdbc://${USERNAME}`);
      expect(JSON.stringify(out)).not.toContain('s3cr3tPassw0rd');
    });
  }

  it('a source literal EQUAL to a recorded plaintext is kept too (#7037)', () => {
    const out = redactForState(
      { MasterUsername: 'postgres', Other: 'postgres' },
      {
        provenance: 'template-derived',
        secrets: pass(),
        source: { MasterUsername: 'postgres', Other: USERNAME },
        generation: 'same-generation',
      }
    ) as Record<string, unknown>;
    expect(out['MasterUsername']).toBe('postgres');
    expect(out['Other']).toBe(USERNAME);
  });

  it('a STATE source does not license the keep: its literal may be a legacy plaintext', () => {
    const out = redactForState(
      { Engine: 'aurora-postgresql' },
      { provenance: 'state-readback', secrets: pass(), source: { Engine: 'aurora-postgresql' } }
    ) as Record<string, unknown>;
    expect(out['Engine']).toBe(MANGLED_ENGINE);
  });

  it('no source: the value scan is unchanged', () => {
    const out = redactForState(
      { Engine: 'aurora-postgresql' },
      { provenance: 'value-scan', secrets: pass() }
    ) as Record<string, unknown>;
    expect(out['Engine']).toBe(MANGLED_ENGINE);
  });

  it('RESIDUAL: a readback on an EMPTY map still takes the derived needle', () => {
    // `cdkd state refresh-observed` / `import` / `drift --accept`: the walk has
    // no template, so it cannot tell the literal from a legacy plaintext, and
    // the derived needle learned from `MasterUsername` reaches `Engine` in
    // `observedProperties` (never `properties`). `cdkd drift` re-resolves the
    // baseline before comparing; scrub and the next deploy put it back.
    const out = redactForState(
      { Engine: 'aurora-postgresql', MasterUsername: 'postgres' },
      {
        provenance: 'state-baseline',
        secrets: new Map(),
        source: { Engine: 'aurora-postgresql', MasterUsername: USERNAME },
      }
    ) as Record<string, unknown>;
    expect(out['MasterUsername']).toBe(USERNAME);
    expect(out['Engine']).toBe(MANGLED_ENGINE);
  });
});

describe('the spelling a pre-#6303 walk persisted, met by a re-positioning pass', () => {
  it('`cdkd scrub`: a record holding the mangled literal takes the template literal', () => {
    const out = redactForState(
      {
        Engine: MANGLED_ENGINE,
        DBClusterParameterGroupName: `default.aurora-${USERNAME}ql16`,
        MasterUsername: USERNAME,
      },
      {
        provenance: 'template-sourced',
        secrets: pass(),
        source,
        generation: 'unproven',
      }
    ) as Record<string, unknown>;
    expect(out['Engine']).toBe('aurora-postgresql');
    expect(out['DBClusterParameterGroupName']).toBe('default.aurora-postgresql16');
    expect(out['MasterUsername']).toBe(USERNAME);
  });

  it('the observed walk over the repositioned record takes it too', () => {
    const out = redactForState(
      { Engine: MANGLED_ENGINE },
      {
        provenance: 'state-cross-generation',
        secrets: pass(),
        source: { Engine: 'aurora-postgresql' },
      }
    ) as Record<string, unknown>;
    expect(out['Engine']).toBe('aurora-postgresql');
  });

  it('an EDITED literal is not repaired: the rendering must equal it', () => {
    const out = redactForState(
      { Engine: MANGLED_ENGINE },
      {
        provenance: 'template-sourced',
        secrets: pass(),
        source: { Engine: 'aurora-mysql' },
        generation: 'unproven',
      }
    ) as Record<string, unknown>;
    expect(out['Engine']).toBe(MANGLED_ENGINE);
  });

  it('a literal EQUAL to a recorded plaintext takes its whole-token record (#7037)', () => {
    // The pre-#7037 walk spelled such a literal as the reference; the
    // template literal is public text, so the repair restores it.
    const out = redactForState(
      { MasterUsername: USERNAME },
      {
        provenance: 'template-sourced',
        secrets: pass(),
        source: { MasterUsername: 'postgres' },
        generation: 'unproven',
      }
    ) as Record<string, unknown>;
    expect(out['MasterUsername']).toBe('postgres');
  });

  it('a mask-only entry never renders: a `***` leaf is not repaired', () => {
    const secrets: RecordedSecretValues = new Map([['postgres', '***']]);
    const out = redactForState(
      { Engine: 'aurora-***ql' },
      {
        provenance: 'template-sourced',
        secrets,
        source: { Engine: 'aurora-postgresql' },
        generation: 'unproven',
      }
    ) as Record<string, unknown>;
    expect(out['Engine']).toBe('aurora-***ql');
  });
});

describe('a rollback restore of a record with the literal (#6303)', () => {
  it('keeps the literal and restores the reference', () => {
    const out = redactRollbackRecord(
      {
        physicalId: 'db',
        resourceType: 'AWS::RDS::DBCluster',
        properties: { Engine: 'aurora-postgresql', MasterUsername: 'postgres' },
        attributes: {},
        dependencies: [],
      } as never,
      pass(),
      { Engine: 'aurora-postgresql', MasterUsername: USERNAME }
    );
    expect(out.properties).toEqual({ Engine: 'aurora-postgresql', MasterUsername: USERNAME });
  });
});

describe('keepTemplateLiteralLeaves (#6303)', () => {
  it('never un-masks a leaf the walk masked whole', () => {
    // A literal containing a containment needle (a fresh `NoEcho` value) is
    // flattened to `***` by the post-pass; putting the literal back would
    // persist that value in the observed bag.
    expect(
      keepTemplateLiteralLeaves({ A: '***' }, { A: 'x-lit' }, { A: 'x-lit' }, new Map())
    ).toEqual({ A: '***' });
  });

  it('puts back a leaf equal to the template literal, and only that one', () => {
    expect(
      keepTemplateLiteralLeaves(
        { A: MANGLED_ENGINE, B: USERNAME, C: [MANGLED_ENGINE] },
        { A: 'aurora-postgresql', B: 'postgres', C: ['aurora-postgresql'] },
        { A: 'aurora-postgresql', B: USERNAME, C: ['aurora-postgresql'] },
        pass()
      )
    ).toEqual({ A: 'aurora-postgresql', B: USERNAME, C: ['aurora-postgresql'] });
  });
});
