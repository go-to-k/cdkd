import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#5298 follow-up: on the `properties`-fallback drift baseline (a
 * record with no `observedProperties`), the template's inline definition still
 * holds `${name}` placeholders beside a `DefinitionSubstitutions` map, while
 * `readCurrentState` reports the substituted `Definition`. The provider's
 * `canonicalizeDriftProperties` folds the template shape into the readback
 * shape so the substitution is not reported as drift, and real drift still is.
 */

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...l, child: () => ({ ...l, child: vi.fn() }) }) };
});

import { StepFunctionsProvider } from '../../../src/provisioning/providers/stepfunctions-provider.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';

const TYPE = 'AWS::StepFunctions::StateMachine';
const ROLE = 'arn:aws:iam::123456789012:role/sfn';
const asl = (result: string) => ({
  StartAt: 'Greet',
  States: { Greet: { Type: 'Pass', Result: result, ResultPath: '$.greeting', End: true } },
});
// What `readCurrentState` returns for a machine deployed with X = 'v'.
const READBACK = { StateMachineName: 'sm', RoleArn: ROLE, Definition: asl('v') };

const drift = (baseline: Record<string, unknown>, aws: Record<string, unknown>) => {
  const p = new StepFunctionsProvider();
  return calculateResourceDrift(
    p.canonicalizeDriftProperties(TYPE, baseline),
    p.canonicalizeDriftProperties(TYPE, aws)
  );
};

describe('StepFunctionsProvider.canonicalizeDriftProperties (issue #5298)', () => {
  const fallbackBaselines: Array<[string, Record<string, unknown>]> = [
    [
      'object Definition',
      { StateMachineName: 'sm', RoleArn: ROLE, Definition: asl('${X}'), DefinitionSubstitutions: { X: 'v' } },
    ],
    [
      'string DefinitionString (the aws-cdk-lib StateMachine shape)',
      {
        StateMachineName: 'sm',
        RoleArn: ROLE,
        DefinitionString: JSON.stringify(asl('${X}')),
        DefinitionSubstitutions: { X: 'v' },
      },
    ],
    [
      'string DefinitionString without substitutions',
      { StateMachineName: 'sm', RoleArn: ROLE, DefinitionString: JSON.stringify(asl('v')) },
    ],
  ];

  it.each(fallbackBaselines)('%s: an unchanged machine reports no drift', (_label, baseline) => {
    // Without the fold the comparator reports the substituted leaf and/or the
    // template-only keys.
    expect(calculateResourceDrift(baseline, READBACK)).not.toEqual([]);
    expect(drift(baseline, READBACK)).toEqual([]);
  });

  it.each(fallbackBaselines)('%s: a console edit of the definition is still drift', (_label, baseline) => {
    const changes = drift(baseline, { ...READBACK, Definition: asl('edited') });
    expect(changes).toEqual([
      { path: 'Definition.States.Greet.Result', stateValue: 'v', awsValue: 'edited' },
    ]);
  });

  it('keeps DefinitionString precedence over a Definition beside it (the --accept limit)', () => {
    // `drift --accept` on a DefinitionString fallback record writes the drifted
    // leaf as a partial `Definition` beside the DefinitionString. The fold
    // follows CloudFormation's precedence, so the accepted leaf is not what is
    // compared and the drift is reported again (documented on the method).
    const accepted = {
      StateMachineName: 'sm',
      RoleArn: ROLE,
      DefinitionString: JSON.stringify(asl('${X}')),
      DefinitionSubstitutions: { X: 'v' },
      Definition: { States: { Greet: { Result: 'edited' } } },
    };
    expect(drift(accepted, { ...READBACK, Definition: asl('edited') })).toEqual([
      { path: 'Definition.States.Greet.Result', stateValue: 'v', awsValue: 'edited' },
    ]);
  });

  it('folds a NoEcho mask substitution as the WHOLE leaf mask, never spliced', async () => {
    const { SECRET_MASK } = await import('../../../src/deployment/secret-redaction.js');
    const p = new StepFunctionsProvider();
    const quoted = p.canonicalizeDriftProperties(TYPE, {
      DefinitionString: JSON.stringify({ A: 'Bearer ${T}', B: '${P}', C: { 'k-${T}': 1 } }),
      DefinitionSubstitutions: { T: SECRET_MASK, P: 'pub' },
    });
    expect(quoted['Definition']).toEqual({ A: SECRET_MASK, B: 'pub', C: SECRET_MASK });
    // Outside quotes the body does not parse: the whole Definition is the mask.
    const bare = p.canonicalizeDriftProperties(TYPE, {
      DefinitionString: '{"Seconds":${T}}',
      DefinitionSubstitutions: { T: SECRET_MASK },
    });
    expect(bare['Definition']).toBe(SECRET_MASK);
  });

  it('returns the readback / observed shape by identity', () => {
    const p = new StepFunctionsProvider();
    expect(p.canonicalizeDriftProperties(TYPE, READBACK)).toBe(READBACK);
  });

  it('returns a DefinitionS3Location bag by identity (no inline form to fold)', () => {
    const p = new StepFunctionsProvider();
    const bag = {
      RoleArn: ROLE,
      DefinitionS3Location: { Bucket: 'b', Key: 'k' },
      DefinitionSubstitutions: { X: 'v' },
    };
    expect(p.canonicalizeDriftProperties(TYPE, bag)).toBe(bag);
  });

  it('does not mutate its input', () => {
    const p = new StepFunctionsProvider();
    const bag = { RoleArn: ROLE, Definition: asl('${X}'), DefinitionSubstitutions: { X: 'v' } };
    const before = JSON.stringify(bag);
    const out = p.canonicalizeDriftProperties(TYPE, bag);
    expect(JSON.stringify(bag)).toBe(before);
    expect(out).toEqual({ RoleArn: ROLE, Definition: asl('v') });
  });
});

describe('StepFunctionsProvider.getDriftSecretPathAliases (issue #5332)', () => {
  const p = new StepFunctionsProvider();
  const aliases = (properties: Record<string, unknown>, secretPaths: string[]) =>
    p.getDriftSecretPathAliases(TYPE, properties, new Set(secretPaths));
  const body = {
    StartAt: 'Call',
    States: {
      Call: {
        Type: 'Task',
        Parameters: { Auth: 'Bearer ${Tok}', Public: '${Pub}', List: ['a', 'x-${Tok}'] },
        End: true,
      },
    },
  };

  it('names every Definition leaf that references a secret substitution (array -> its path)', () => {
    const props = { DefinitionString: JSON.stringify(body), DefinitionSubstitutions: { Tok: 'E', Pub: 'p' } };
    expect(aliases(props, ['DefinitionSubstitutions.Tok']).sort()).toEqual([
      'Definition.States.Call.Parameters.Auth',
      'Definition.States.Call.Parameters.List',
    ]);
  });

  it('reads an object Definition too, and a whole-map secret path covers every name', () => {
    const props = { Definition: body, DefinitionSubstitutions: { Tok: 'E', Pub: 'p' } };
    expect(aliases(props, ['DefinitionSubstitutions']).sort()).toEqual([
      'Definition.States.Call.Parameters.Auth',
      'Definition.States.Call.Parameters.List',
      'Definition.States.Call.Parameters.Public',
    ]);
  });

  it('returns nothing when no substitution is secret-bearing', () => {
    const props = { Definition: body, DefinitionSubstitutions: { Tok: 'E' } };
    expect(aliases(props, ['RoleArn', 'DefinitionSubstitutionsX.Tok'])).toEqual([]);
    expect(aliases({ Definition: body }, ['DefinitionSubstitutions.Tok'])).toEqual([]);
  });

  it('falls back to the whole Definition when the body cannot be walked', () => {
    // Not JSON until substituted (a bare numeric placeholder), and the S3 form.
    expect(
      aliases(
        { DefinitionString: '{"TimeoutSeconds":${Tok}}', DefinitionSubstitutions: { Tok: 'E' } },
        ['DefinitionSubstitutions.Tok']
      )
    ).toEqual(['Definition']);
    expect(
      aliases(
        { DefinitionS3Location: { Bucket: 'b', Key: 'k' }, DefinitionSubstitutions: { Tok: 'E' } },
        ['DefinitionSubstitutions.Tok']
      )
    ).toEqual(['Definition']);
  });
});
