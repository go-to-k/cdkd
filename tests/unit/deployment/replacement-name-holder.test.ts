/**
 * `replacementRequestsDifferentName` (issue #3808): a positive answer REFUSES
 * the `--replace` delete-first retry, so every "may be the same name" shape
 * must answer `undefined`, and only a KNOWN difference may answer.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  nameAdoptingSdkCreateTypes,
  probeErrorMeansNameHeld,
  probeFoundSameId,
  renderReplacementNameChange,
  renderNameHeldElsewhere,
  replacementDerivedGeneratedNames,
  replacementMovesEventBus,
  replacementNameProbe,
  replacementOrderIsCaseSensitive,
  replacementOldHoldsSentName,
  replacementRequestsDifferentName,
  reverseReplacementNameKeyKind,
  reverseReplacementNewHoldsName,
  reverseReplacementTrustsGeneratedName,
} from '../../../src/deployment/replacement-name-holder.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withStackName } from '../../../src/provisioning/resource-name.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';

const FN = 'AWS::Lambda::Function';

function ask(over: Partial<Parameters<typeof replacementRequestsDifferentName>[0]>) {
  return replacementRequestsDifferentName({
    oldResourceType: FN,
    newResourceType: FN,
    desiredProperties: { FunctionName: 'taken-name' },
    recorded: { FunctionName: 'my-fn' },
    observed: undefined,
    physicalId: 'my-fn',
    ...over,
  });
}

describe('replacementRequestsDifferentName', () => {
  it('answers when the recorded name differs from the desired one', () => {
    expect(ask({})).toEqual({
      property: 'FunctionName',
      desiredName: 'taken-name',
      heldName: 'my-fn',
      heldProperty: 'FunctionName',
      physicalId: 'my-fn',
    });
  });

  it('answers undefined when the replacement keeps the name (the --replace case)', () => {
    expect(ask({ desiredProperties: { FunctionName: 'my-fn' } })).toBeUndefined();
  });

  it('compares case-insensitively, since some services treat case variants as one name', () => {
    expect(ask({ desiredProperties: { FunctionName: 'MY-FN' } })).toBeUndefined();
  });

  it('answers undefined when the template declares no explicit name', () => {
    expect(ask({ desiredProperties: { Runtime: 'nodejs22.x' } })).toBeUndefined();
    expect(ask({ desiredProperties: { FunctionName: '' } })).toBeUndefined();
    expect(ask({ desiredProperties: { FunctionName: { Ref: 'X' } } })).toBeUndefined();
  });

  it('answers undefined for a type with no known name property', () => {
    expect(
      ask({
        oldResourceType: 'AWS::Pipes::Pipe',
        newResourceType: 'AWS::Pipes::Pipe',
        desiredProperties: { Name: 'taken-name' },
        recorded: { Name: 'my-pipe' },
      })
    ).toBeUndefined();
  });

  it('reads the observed name when the recorded bag has none', () => {
    expect(
      ask({ recorded: {}, observed: { FunctionName: 'taken-name' } })
    ).toBeUndefined();
    expect(
      ask({ recorded: {}, observed: { FunctionName: 'my-fn' } })?.heldName
    ).toBe('my-fn');
  });

  it('prefers the recorded name over the observed one', () => {
    expect(
      ask({
        recorded: { FunctionName: 'taken-name' },
        observed: { FunctionName: 'other' },
      })
    ).toBeUndefined();
  });

  it('skips a redacted recorded value rather than reading it as a name', () => {
    // With the mask skipped, the physical id decides: it embeds the name.
    expect(
      ask({
        recorded: { FunctionName: SECRET_MASK },
        physicalId: 'taken-name',
      })
    ).toBeUndefined();
  });

  it('skips an unresolved dynamic reference state keeps as written', () => {
    // The desired bag is RESOLVED; the record keeps the expression. Read as a
    // name it would differ from the plaintext and refuse a same-name --replace.
    expect(
      ask({
        desiredProperties: { FunctionName: 'my-fn' },
        recorded: { FunctionName: '{{resolve:secretsmanager:app:SecretString:fn}}' },
        physicalId: 'my-fn',
      })
    ).toBeUndefined();
  });

  it('does not render an unresolved reference as the held name', () => {
    const change = ask({
      recorded: { FunctionName: '{{resolve:secretsmanager:app:SecretString:fn}}' },
      physicalId: 'sg-opaque',
    });
    expect(change).toBeDefined();
    expect(change?.heldName).toBeUndefined();
  });

  it('lets a physical id naming the desired name override a differing recorded one', () => {
    // IAM normalises `_` to `-`: the record keeps the template's `app_role`
    // while AWS holds `app-role`, which the template now spells directly.
    expect(
      ask({
        oldResourceType: 'AWS::IAM::Role',
        newResourceType: 'AWS::IAM::Role',
        desiredProperties: { RoleName: 'app-role' },
        recorded: { RoleName: 'app_role' },
        physicalId: 'app-role',
      })
    ).toBeUndefined();
  });

  describe('with no recorded name, the physical id stands in', () => {
    it('answers when the desired name appears nowhere in the physical id', () => {
      expect(ask({ recorded: {}, physicalId: 'MyStack-Fn' })).toEqual({
        property: 'FunctionName',
        desiredName: 'taken-name',
        heldName: undefined,
        heldProperty: undefined,
        physicalId: 'MyStack-Fn',
      });
    });

    it('answers undefined when the physical id embeds the desired name (an ARN or URL)', () => {
      expect(
        ask({
          recorded: {},
          physicalId: 'arn:aws:lambda:us-east-1:123456789012:function:Taken-Name',
        })
      ).toBeUndefined();
    });

    it('answers for a desired name that is only a SUBSTRING of the physical id', () => {
      // A generated `{stack}-{logicalId}` embeds a logical-id-shaped name; the
      // old resource still does not hold it.
      expect(
        ask({ recorded: {}, desiredProperties: { FunctionName: 'orders' }, physicalId: 'MyStack-Orders' })
      ).toBeDefined();
      expect(
        ask({ recorded: {}, desiredProperties: { FunctionName: 'mystack' }, physicalId: 'MyStack-Orders' })
      ).toBeDefined();
    });

    it('reads a queue URL and an IAM path by their final segment', () => {
      expect(
        ask({
          recorded: {},
          physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/taken-name',
        })
      ).toBeUndefined();
      expect(
        ask({ recorded: {}, physicalId: 'arn:aws:iam::123456789012:role/app/taken-name' })
      ).toBeUndefined();
    });

    it("reads Secrets Manager's 6-character suffix as the same name", () => {
      expect(
        ask({
          recorded: {},
          physicalId: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:taken-name-AbC123',
        })
      ).toBeUndefined();
    });

    it('does not read a `/` inside a name-shaped physical id as a separator', () => {
      // SSM `/app/db` renamed to `db`, which another parameter holds.
      expect(
        ask({
          oldResourceType: 'AWS::SSM::Parameter',
          newResourceType: 'AWS::SSM::Parameter',
          desiredProperties: { Name: 'db' },
          recorded: { Name: '/app/db' },
          physicalId: '/app/db',
        })
      ).toBeDefined();
      expect(ask({ recorded: {}, physicalId: '/aws/lambda/taken-name' })).toBeDefined();
    });

    it('reads a `|`-joined composite id by its final segment', () => {
      expect(ask({ recorded: {}, physicalId: 'my-bus|taken-name' })).toBeUndefined();
    });

    it('does not read a longer secret name as the desired one', () => {
      expect(
        ask({
          recorded: {},
          desiredProperties: { FunctionName: 'taken' },
          physicalId: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:taken-name-AbC123',
        })
      ).toBeDefined();
    });

    it('answers for an opaque id, refusing (without deleting) even if the name matched', () => {
      expect(ask({ recorded: {}, physicalId: 'sg-0123456789abcdef0' })).toBeDefined();
    });

    it('answers undefined for an empty physical id', () => {
      expect(ask({ recorded: {}, physicalId: '' })).toBeUndefined();
    });
  });

  it('reads the OLD type’s name property on the held side across a Type change', () => {
    // SQS's name property is QueueName; a `FunctionName` on the old bag must
    // not be read for it.
    expect(
      ask({
        oldResourceType: 'AWS::SQS::Queue',
        recorded: { QueueName: 'taken-name', FunctionName: 'my-fn' },
        physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/q',
      })
    ).toBeUndefined();
  });
});

describe('renderNameHeldElsewhere', () => {
  it('names both names when state records the held one', () => {
    const text = renderNameHeldElsewhere({
      property: 'FunctionName',
      desiredName: 'taken-name',
      heldName: 'my-fn',
      heldProperty: 'FunctionName',
      physicalId: 'my-fn',
    });
    expect(text).toContain('asks for FunctionName "taken-name"');
    expect(text).toContain('holds FunctionName "my-fn"');
    expect(text).toContain('held by ANOTHER existing resource');
  });

  it('says the old resource does not hold the name when state records none', () => {
    const text = renderNameHeldElsewhere({
      property: 'FunctionName',
      desiredName: 'taken-name',
      heldName: undefined,
      heldProperty: undefined,
      physicalId: 'MyStack-Fn',
    });
    expect(text).toContain('(MyStack-Fn) does not hold that name');
  });

  it('renders a line break in a name inertly', () => {
    const text = renderNameHeldElsewhere({
      property: 'FunctionName',
      desiredName: 'taken\nname',
      heldName: 'my-fn',
      heldProperty: 'FunctionName',
      physicalId: 'my-fn',
    });
    expect(text).not.toContain('\n');
  });
});

/**
 * `replacementOldHoldsSentName` (issue #3979): the deploy direction of the
 * rollback's holder proof. `--replace` deletes the OLD resource first only on
 * `holds: true`.
 */
describe('replacementOldHoldsSentName', () => {
  const PIPE = 'AWS::Pipes::Pipe';
  const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
  const TG_ARN = (name: string) =>
    `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/${name}/0123456789abcdef`;

  function holds(over: Partial<Parameters<typeof replacementOldHoldsSentName>[0]>) {
    return replacementOldHoldsSentName({
      createType: FN,
      holderType: FN,
      requested: { FunctionName: 'my-fn' },
      recorded: { FunctionName: 'my-fn' },
      observed: undefined,
      physicalId: 'my-fn',
      ...over,
    });
  }

  it('holds when the old resource holds the name the create sent', () => {
    expect(holds({}).holds).toBe(true);
  });

  it('speaks of the create and the resource being replaced, not the rollback', () => {
    const verdict = holds({ requested: { FunctionName: 'other' } });
    expect(verdict).toEqual({
      holds: false,
      known: true,
      diagnosis:
        'the create asked for FunctionName "other", while the resource being replaced (my-fn) ' +
        'holds "my-fn"',
    });
  });

  it('a nameless create proves a holder only through the generated name its provider mints', () => {
    const generated = { FunctionName: 'MyStack-Fn' };
    expect(
      holds({ requested: {}, generated, recorded: {}, physicalId: 'MyStack-Fn' }).holds
    ).toBe(true);
    // The template DROPPED an explicit name: the old function holds another one.
    const dropped = holds({ requested: {}, generated, recorded: { FunctionName: 'app-fn' }, physicalId: 'app-fn' });
    expect(dropped.holds).toBe(false);
    expect(dropped.holds === false && dropped.known).toBe(false);
  });

  it('a type with no name key is proven only by the sent identifier EQUAL to the old physical id', () => {
    const base = {
      createType: PIPE,
      holderType: PIPE,
      createdVia: 'cc-api' as const,
      holderVia: 'cc-api' as const,
    };
    const same = (requested: Record<string, unknown>, physicalId: string) =>
      holds({ ...base, requested, recorded: { ...requested }, physicalId }).holds;
    expect(same({ Name: 'my-pipe' }, 'my-pipe')).toBe(true);
    expect(same({ DomainIdentifier: 'd-1' }, 'd-1')).toBe(true);
    // The observed bag stands in for a record that lacks the key.
    expect(
      holds({ ...base, requested: { Name: 'my-pipe' }, recorded: {}, observed: { Name: 'my-pipe' }, physicalId: 'my-pipe' })
        .holds
    ).toBe(true);
    // Exact: a case-only difference, a composite id ending in the name, or a
    // non-name-shaped key never proves it.
    expect(same({ Name: 'My-Pipe' }, 'my-pipe')).toBe(false);
    expect(same({ Name: 'my-pipe' }, 'p|my-pipe')).toBe(false);
    expect(same({ Source: 'my-pipe' }, 'my-pipe')).toBe(false);
    expect(same({ Name: 'my-pipe' }, '')).toBe(false);
  });

  it('the identity rule needs EVERY name-shaped property the create sent unchanged on the old record', () => {
    // A rename (Name my-app -> my-app-v2) whose OTHER name-shaped property
    // still spells the old id: the collision on my-app-v2 is someone else's.
    const renamed = holds({
      createType: PIPE,
      holderType: PIPE,
      createdVia: 'cc-api',
      holderVia: 'cc-api',
      requested: { Name: 'my-app-v2', RoleName: 'my-app' },
      recorded: { Name: 'my-app', RoleName: 'my-app' },
      physicalId: 'my-app',
    });
    expect(renamed.holds).toBe(false);
    // DROPPING the primary name while another name-shaped property still
    // spells the old id is a change too.
    expect(
      holds({
        createType: PIPE,
        holderType: PIPE,
        createdVia: 'cc-api',
        holderVia: 'cc-api',
        requested: { SourceName: 'old' },
        recorded: { Name: 'old', SourceName: 'old' },
        physicalId: 'old',
      }).holds
    ).toBe(false);
    // A name AWS reports only in the read-back (never declared) is no change.
    expect(
      holds({
        createType: PIPE,
        holderType: PIPE,
        createdVia: 'cc-api',
        holderVia: 'cc-api',
        requested: { Name: 'old' },
        recorded: { Name: 'old' },
        observed: { Name: 'old', DefaultedName: 'aws-chose-this' },
        physicalId: 'old',
      }).holds
    ).toBe(true);
    // A record that does not say what the key held proves nothing either.
    expect(
      holds({
        createType: PIPE,
        holderType: PIPE,
        createdVia: 'cc-api',
        holderVia: 'cc-api',
        requested: { Name: 'my-pipe' },
        recorded: {},
        physicalId: 'my-pipe',
      }).holds
    ).toBe(false);
  });

  it('the identity rule holds only on the Cloud Control route, for the create and the holder', () => {
    // An SDK provider's physical id need not be the primary identifier.
    const ask = (createdVia?: 'sdk' | 'cc-api', holderVia?: 'sdk' | 'cc-api') =>
      holds({
        createType: PIPE,
        holderType: PIPE,
        requested: { Name: 'my-pipe' },
        recorded: { Name: 'my-pipe' },
        physicalId: 'my-pipe',
        ...(createdVia && { createdVia }),
        ...(holderVia && { holderVia }),
      }).holds;
    expect(ask('cc-api', 'cc-api')).toBe(true);
    expect(ask('sdk', 'cc-api')).toBe(false);
    expect(ask('cc-api', 'sdk')).toBe(false);
    expect(ask('cc-api', undefined)).toBe(false);
    expect(ask(undefined, 'cc-api')).toBe(false);
  });

  it('a nameless SDK create of a type whose provider wraps the generated name is proven through the derived name', () => {
    const cases: Array<[string, string, string]> = [
      ['AWS::Logs::LogGroup', 'LogGroupName', '/cdkd/MyStack-Lg'],
      ['AWS::SSM::Parameter', 'Name', '/MyStack-Lg'],
      ['AWS::S3::Bucket', 'BucketName', 'mystack-lg'],
      ['AWS::CodeCommit::Repository', 'RepositoryName', 'MyStack-Lg'],
    ];
    for (const [type, property, sent] of cases) {
      const ask = (physicalId: string, createdVia: 'sdk' | 'cc-api' = 'sdk') =>
        withStackName('MyStack', () =>
          holds({
            createType: type,
            holderType: type,
            requested: {},
            recorded: {},
            physicalId,
            logicalId: 'Lg',
            createdVia,
          })
        );
      expect(ask(sent).holds, type).toBe(true);
      const other = ask(`${sent}x`);
      expect(other.holds, type).toBe(false);
      expect(other.holds === false && other.diagnosis, type).toContain(
        `cdkd's rule generates ${property} "${sent}"`
      );
      // On the Cloud Control route the bag itself carries whatever was sent.
      expect(ask(sent, 'cc-api').holds, type).toBe(false);
    }
    // A scoped type still needs its scope.
    const schedule = withStackName('MyStack', () =>
      holds({
        createType: 'AWS::Scheduler::Schedule',
        holderType: 'AWS::Scheduler::Schedule',
        requested: { GroupName: 'g2' },
        recorded: { GroupName: 'g1' },
        physicalId: 'MyStack-Lg',
        logicalId: 'Lg',
      })
    );
    expect(schedule.holds).toBe(false);
  });

  it("each derived name keeps its provider's length cap once the logical id overflows it", () => {
    // The cap is what a truncated name differs on, and a short id never
    // reaches it: the lengths are the providers' own maxLength (plus the wrap).
    const expected: Record<string, number> = {
      'AWS::AutoScaling::AutoScalingGroup': 255,
      'AWS::CodeCommit::Repository': 100,
      'AWS::DynamoDB::GlobalTable': 255,
      'AWS::Logs::LogGroup': 506 + '/cdkd/'.length,
      'AWS::RDS::DBProxy': 64,
      'AWS::RDS::DBProxyEndpoint': 64,
      'AWS::S3::Bucket': 63,
      'AWS::Scheduler::Schedule': 64,
      'AWS::SSM::Parameter': 1023 + '/'.length,
    };
    const table = replacementDerivedGeneratedNames();
    expect(Object.keys(table).sort()).toEqual(Object.keys(expected).sort());
    const longId = 'L'.repeat(1100);
    for (const [type, length] of Object.entries(expected)) {
      const name = withStackName('MyStack', () => table[type]!.derive(longId));
      expect(name.length, type).toBe(length);
      // ...and that exact name is what proves the holder.
      const verdict = withStackName('MyStack', () =>
        holds({
          createType: type,
          holderType: type,
          requested: {},
          recorded: {},
          physicalId: name,
          logicalId: longId,
        })
      );
      expect(verdict.holds, type).toBe(true);
    }
  });

  it('each derived-name entry is the provider expression it claims, in the provider file', () => {
    const table = replacementDerivedGeneratedNames();
    expect(Object.keys(table).length).toBeGreaterThanOrEqual(9);
    for (const [type, { file, source }] of Object.entries(table)) {
      const text = readFileSync(join(process.cwd(), 'src/provisioning/providers', file), 'utf-8');
      // Exactly once, and as the fallback of the create's name assignment
      // (`|| ` / `?? ` after the name property), not a copy elsewhere.
      expect(text.split(source).length - 1, `${type}: ${file} occurrences of ${source}`).toBe(1);
      const at = text.indexOf(source);
      expect(
        /as string \| undefined\)\s*(\|\||\?\?)\s*$/.test(text.slice(Math.max(0, at - 120), at)),
        `${type}: ${source} is not the create's name fallback in ${file}`
      ).toBe(true);
      // Never also trusted as verbatim: one table owns a type.
      expect(reverseReplacementTrustsGeneratedName(type), type).toBe(false);
    }
  });

  it('the derived generated names are the deploy side only: the rollback still refuses them', () => {
    const verdict = withStackName('CdkdX', () =>
      reverseReplacementNewHoldsName({
        oldResourceType: 'AWS::Logs::LogGroup',
        newResourceType: 'AWS::Logs::LogGroup',
        requested: {},
        recorded: {},
        observed: undefined,
        physicalId: '/cdkd/CdkdX-Lg',
        logicalId: 'Lg',
        createdVia: 'sdk',
      })
    );
    expect(verdict.holds).toBe(false);
  });

  it('the identity rule is the deploy side only: the rollback still refuses an unkeyed type', () => {
    const verdict = reverseReplacementNewHoldsName({
      oldResourceType: PIPE,
      newResourceType: PIPE,
      requested: { Name: 'my-pipe' },
      recorded: {},
      observed: undefined,
      physicalId: 'my-pipe',
    });
    expect(verdict.holds).toBe(false);
  });

  it('never proves across a Type change by identity, nor a not-name-keyed type', () => {
    expect(
      holds({ createType: PIPE, holderType: 'AWS::SQS::Queue', requested: { Name: 'q' }, physicalId: 'q' }).holds
    ).toBe(false);
    const NESTED = 'AWS::CloudFormation::Stack';
    // On Cloud Control both sides, with the identifier sent and recorded: only
    // the not-name-keyed gate refuses it.
    expect(
      holds({
        createType: NESTED,
        holderType: NESTED,
        requested: { StackName: 's' },
        recorded: { StackName: 's' },
        physicalId: 's',
        createdVia: 'cc-api',
        holderVia: 'cc-api',
      }).holds
    ).toBe(false);
  });

  it('an ELBv2 target group keeping its name: the sent (prefixed) name is proven through the ARN', () => {
    const verdict = withStackName('MyStack', () =>
      holds({
        createType: TG,
        holderType: TG,
        requested: { Name: 'tg', Port: 8081 },
        recorded: { Name: 'tg', Port: 8080 },
        physicalId: TG_ARN('MyStack-tg'),
        logicalId: 'Tg',
      })
    );
    expect(verdict.holds).toBe(true);
    // The same records with the old group named WITHOUT the prefix: the create
    // sent `MyStack-tg`, which that group never held.
    const other = withStackName('MyStack', () =>
      holds({
        createType: TG,
        holderType: TG,
        requested: { Name: 'tg' },
        recorded: { Name: 'tg' },
        physicalId: TG_ARN('tg'),
        logicalId: 'Tg',
      })
    );
    expect(other.holds).toBe(false);
    expect(other.holds === false && other.diagnosis).toContain('sends as "MyStack-tg"');
  });

  it('a Route 53 record speaks of the record being replaced', () => {
    const REC = 'AWS::Route53::RecordSet';
    const verdict = holds({
      createType: REC,
      holderType: REC,
      requested: { HostedZoneId: 'Z1', Name: 'a.example.com', Type: 'A' },
      recorded: { HostedZoneId: 'Z1', Name: 'b.example.com', Type: 'A' },
      physicalId: 'Z1|b.example.com|A',
    });
    expect(verdict.holds === false && verdict.diagnosis).toBe(
      'the create asked for Name "a.example.com", while the record being replaced ' +
        '("Z1|b.example.com|A") holds Name "b.example.com"'
    );
  });
});

describe('the parent review round of #3979 (helper)', () => {
  function holds(over: Partial<Parameters<typeof replacementOldHoldsSentName>[0]>) {
    return replacementOldHoldsSentName({
      createType: FN,
      holderType: FN,
      requested: { FunctionName: 'my-fn' },
      recorded: { FunctionName: 'my-fn' },
      observed: undefined,
      physicalId: 'my-fn',
      ...over,
    });
  }

  it('each derive() applies its provider options: case, charset and wrap', () => {
    const table = replacementDerivedGeneratedNames();
    const derive = (type: string) => withStackName('MyStack', () => table[type]!.derive('Lg_A.b/C'));
    expect(derive('AWS::S3::Bucket')).toBe('mystack-lg-a.b-c');
    expect(derive('AWS::Logs::LogGroup')).toBe('/cdkd/MyStack-Lg_A-b/C');
    expect(derive('AWS::SSM::Parameter')).toBe('/MyStack-Lg_A-b/C');
    expect(derive('AWS::CodeCommit::Repository')).toBe('MyStack-Lg-A-b-C');
  });

  it('a nameless create whose derived name sanitizes to EMPTY never proves a holder', () => {
    // Outside a stack scope, a logical id of only rewritten characters derives
    // ''; an empty name would "match" the final segment of an id ending `|`.
    const verdict = holds({
      createType: 'AWS::S3::Bucket',
      holderType: 'AWS::S3::Bucket',
      requested: {},
      recorded: {},
      physicalId: 'a|',
      logicalId: '___',
      createdVia: 'sdk',
    });
    expect(verdict.holds).toBe(false);
  });

  it('the older-record hint is given only for that shape', () => {
    const PIPE = 'AWS::Pipes::Pipe';
    const legacy = (verdict: ReturnType<typeof holds>) =>
      verdict.holds === false && verdict.diagnosis.includes('written by an older cdkd');
    const base = {
      createType: PIPE,
      holderType: PIPE,
      requested: { Name: 'p' },
      recorded: { Name: 'p' },
      physicalId: 'p',
    };
    expect(legacy(holds({ ...base, createdVia: 'cc-api' }))).toBe(true);
    expect(legacy(holds({ ...base, createdVia: 'sdk' }))).toBe(false);
    expect(legacy(holds({ ...base, createdVia: 'cc-api', holderVia: 'sdk' }))).toBe(false);
    expect(legacy(holds({ ...base, createdVia: 'cc-api', requested: { Name: 'q' } }))).toBe(false);
    const rollback = reverseReplacementNewHoldsName({
      oldResourceType: PIPE,
      newResourceType: PIPE,
      requested: { Name: 'p' },
      recorded: { Name: 'p' },
      observed: undefined,
      physicalId: 'p',
      createdVia: 'cc-api',
    });
    expect(rollback.holds === false && rollback.diagnosis.includes('written by an older cdkd')).toBe(
      false
    );
  });

  it('an inherited key is no table entry', () => {
    // Nor a name KEY: the generic name table is indexed plainly.
    for (const type of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(reverseReplacementNameKeyKind(type), type).toBe('unknown');
    }
    for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const verdict = holds({
        createType: type,
        holderType: type,
        requested: { Name: 'x' },
        recorded: { Name: 'x' },
        physicalId: 'x',
        logicalId: 'X',
      });
      expect(verdict.holds, type).toBe(false);
    }
  });

  it('a record and a read-back disagreeing on the name refuse, in both directions', () => {
    const deploy = holds({
      requested: { FunctionName: 'my-fn' },
      recorded: { FunctionName: 'my-fn' },
      observed: { FunctionName: 'renamed-fn' },
      physicalId: 'my-fn',
    });
    expect(deploy.holds).toBe(false);
    expect(deploy.holds === false && deploy.known).toBe(false);
    const rollback = reverseReplacementNewHoldsName({
      oldResourceType: FN,
      newResourceType: FN,
      requested: { FunctionName: 'my-fn' },
      recorded: { FunctionName: 'my-fn' },
      observed: { FunctionName: 'renamed-fn' },
      physicalId: 'my-fn',
    });
    expect(rollback.holds).toBe(false);
    // A case-insensitive name space folds the comparison: RDS reads
    // identifiers back lower-cased, which is no drift...
    expect(
      holds({
        createType: 'AWS::RDS::DBCluster',
        holderType: 'AWS::RDS::DBCluster',
        requested: { DBClusterIdentifier: 'MyDb' },
        recorded: { DBClusterIdentifier: 'MyDb' },
        observed: { DBClusterIdentifier: 'mydb' },
        physicalId: 'mydb',
      }).holds
    ).toBe(true);
    // ...while a case-sensitive one reads a case change as one.
    expect(
      holds({
        requested: { FunctionName: 'my-fn' },
        recorded: { FunctionName: 'my-fn' },
        observed: { FunctionName: 'My-Fn' },
        physicalId: 'my-fn',
      }).holds
    ).toBe(false);
    // Agreeing records still hold.
    expect(
      holds({
        requested: { FunctionName: 'my-fn' },
        recorded: { FunctionName: 'my-fn' },
        observed: { FunctionName: 'my-fn' },
        physicalId: 'my-fn',
      }).holds
    ).toBe(true);
  });
});

describe('replacementNameProbe (go-to-k/cdkd#3937)', () => {
  const change = (physicalId: string, desiredName: string) => ({
    property: 'X',
    desiredName,
    heldName: undefined,
    heldProperty: undefined,
    physicalId,
  });

  it('pins the name-adopting SDK create types', () => {
    expect(nameAdoptingSdkCreateTypes()).toEqual([
      'AWS::CloudWatch::Alarm',
      'AWS::Events::Rule',
      'AWS::S3::Bucket',
      'AWS::SNS::Topic',
      'AWS::SQS::Queue',
      'AWS::StepFunctions::StateMachine',
    ]);
  });

  it("each one's SDK provider has the import() the probe asks", () => {
    const registry = new ProviderRegistry();
    registerAllProviders(registry);
    for (const type of nameAdoptingSdkCreateTypes()) {
      const decision = registry.getProviderFor({ resourceType: type, provisionedBy: 'sdk' });
      expect(decision.provisionedBy, type).toBe('sdk');
      expect(typeof decision.provider.import, type).toBe('function');
    }
  });

  it('asks by the create bag (no extra fields) for a name-lookup type', () => {
    expect(
      replacementNameProbe({
        resourceType: 'AWS::SQS::Queue',
        createdVia: 'sdk',
        change: change('https://sqs.us-east-1.amazonaws.com/1/q', 'other'),
      })
    ).toEqual({});
  });

  it('does not ask for a Cloud Control create, or another type', () => {
    expect(
      replacementNameProbe({
        resourceType: 'AWS::SQS::Queue',
        createdVia: 'cc-api',
        change: change('u', 'other'),
      })
    ).toBeUndefined();
    expect(
      replacementNameProbe({
        resourceType: 'AWS::Lambda::Function',
        createdVia: 'sdk',
        change: change('fn', 'other'),
      })
    ).toBeUndefined();
    // An inherited key is not an entry.
    expect(
      replacementNameProbe({
        resourceType: 'constructor',
        createdVia: 'sdk',
        change: change('fn', 'other'),
      })
    ).toBeUndefined();
  });

  it("derives a state machine's ARN from the old one, and cannot without an ARN", () => {
    const old = 'arn:aws-cn:states:cn-north-1:123456789012:stateMachine:mine';
    expect(
      replacementNameProbe({
        resourceType: 'AWS::StepFunctions::StateMachine',
        createdVia: undefined,
        change: change(old, 'theirs'),
      })
    ).toEqual({ knownPhysicalId: 'arn:aws-cn:states:cn-north-1:123456789012:stateMachine:theirs' });
    expect(
      replacementNameProbe({
        resourceType: 'AWS::StepFunctions::StateMachine',
        createdVia: 'sdk',
        change: change('mine', 'theirs'),
      })
    ).toBeNull();
    // A name that would split the ARN differently is not asked about.
    expect(
      replacementNameProbe({
        resourceType: 'AWS::StepFunctions::StateMachine',
        createdVia: 'sdk',
        change: change(old, 'a:b'),
      })
    ).toBeNull();
  });
});

describe('replacementRequestsDifferentName caseSensitive (go-to-k/cdkd#3937)', () => {
  const q = 'AWS::SQS::Queue';
  const base = {
    oldResourceType: q,
    newResourceType: q,
    desiredProperties: { QueueName: 'Orders' },
    recorded: { QueueName: 'orders' },
    observed: undefined,
    physicalId: 'https://sqs.us-east-1.amazonaws.com/1/orders',
  };

  it('folds a case-only rename by default, and answers it exactly when asked', () => {
    expect(replacementRequestsDifferentName(base)).toBeUndefined();
    expect(replacementRequestsDifferentName({ ...base, caseSensitive: true })).toMatchObject({
      desiredName: 'Orders',
      heldName: 'orders',
    });
  });

  it('still answers undefined for the exact same name', () => {
    expect(
      replacementRequestsDifferentName({
        ...base,
        desiredProperties: { QueueName: 'orders' },
        caseSensitive: true,
      })
    ).toBeUndefined();
    // The physical id alone, exactly.
    expect(
      replacementRequestsDifferentName({
        ...base,
        desiredProperties: { QueueName: 'orders' },
        recorded: undefined,
        caseSensitive: true,
      })
    ).toBeUndefined();
  });
});

describe('replacementMovesEventBus (go-to-k/cdkd#3937)', () => {
  const R = 'AWS::Events::Rule';
  const ask = (
    oldBus: unknown,
    newBus: unknown,
    over: Partial<Parameters<typeof replacementMovesEventBus>[0]> = {}
  ) =>
    replacementMovesEventBus({
      oldResourceType: R,
      newResourceType: R,
      desiredProperties: { Name: 'r', ...(newBus !== undefined && { EventBusName: newBus }) },
      recorded: { Name: 'r', ...(oldBus !== undefined && { EventBusName: oldBus }) },
      observed: undefined,
      physicalId: 'arn:aws:events:us-east-1:1:rule/r',
      ...over,
    });

  it('answers a move between two named buses', () => {
    expect(ask('busA', 'busB')).toMatchObject({
      property: 'EventBusName',
      desiredName: 'busB',
      heldName: 'busA',
    });
  });

  it('treats an absent bus as default, and a bus ARN as its name', () => {
    expect(ask(undefined, 'default')).toBeUndefined();
    expect(ask('default', undefined)).toBeUndefined();
    expect(ask(undefined, 'busB')).toMatchObject({ heldName: 'default', desiredName: 'busB' });
    expect(ask('arn:aws:events:us-east-1:1:event-bus/busA', 'busA')).toBeUndefined();
    expect(ask('busA', 'arn:aws:events:us-east-1:1:event-bus/busB')).toMatchObject({
      desiredName: 'busB',
    });
  });

  it('reads the observed bus when the record has none', () => {
    expect(
      ask(undefined, 'busA', { recorded: { Name: 'r' }, observed: { EventBusName: 'busA' } })
    ).toBeUndefined();
  });

  it('answers nothing for an unreadable bus, or another type', () => {
    expect(ask(SECRET_MASK, 'busB')).toBeUndefined();
    expect(ask('busA', { Ref: 'Bus' })).toBeUndefined();
    expect(ask('busA', '{{resolve:ssm:bus}}')).toBeUndefined();
    expect(ask('busA', 'busB', { oldResourceType: 'AWS::SQS::Queue' })).toBeUndefined();
  });
});

describe('replacementOrderIsCaseSensitive / probeFoundSameId', () => {
  it('folds case only for a type whose name space folds it', () => {
    expect(replacementOrderIsCaseSensitive('AWS::Lambda::Function')).toBe(true);
    expect(replacementOrderIsCaseSensitive('AWS::DynamoDB::Table')).toBe(true);
    expect(replacementOrderIsCaseSensitive('AWS::IAM::Role')).toBe(false);
  });

  it('reads the two SQS URL hosts as one queue, and nothing else loosely', () => {
    const a = 'https://sqs.us-east-1.amazonaws.com/123456789012/q';
    const b = 'https://us-east-1.queue.amazonaws.com/123456789012/q';
    expect(probeFoundSameId('AWS::SQS::Queue', a, b)).toBe(true);
    expect(probeFoundSameId('AWS::SQS::Queue', a, b.replace('/q', '/other'))).toBe(false);
    expect(probeFoundSameId('AWS::SQS::Queue', a, b.replace('123456789012', '999'))).toBe(false);
    expect(probeFoundSameId('AWS::SNS::Topic', a, b)).toBe(false);
    expect(probeFoundSameId('AWS::SNS::Topic', 'x', 'x')).toBe(true);
  });
});

describe('probeErrorMeansNameHeld / renderReplacementNameChange', () => {
  it('reads only an S3 403 as a held name', () => {
    const forbidden = { name: 'Forbidden', $metadata: { httpStatusCode: 403 } };
    expect(probeErrorMeansNameHeld('AWS::S3::Bucket', forbidden)).toBe(true);
    expect(probeErrorMeansNameHeld('AWS::S3::Bucket', { $metadata: { httpStatusCode: 403 } })).toBe(
      true
    );
    expect(probeErrorMeansNameHeld('AWS::S3::Bucket', new Error('AccessDenied'))).toBe(false);
    expect(probeErrorMeansNameHeld('AWS::SQS::Queue', forbidden)).toBe(false);
    expect(probeErrorMeansNameHeld('AWS::S3::Bucket', null)).toBe(false);
    // A named credential or clock failure is not about the name.
    for (const name of ['ExpiredToken', 'RequestTimeTooSkewed', 'InvalidAccessKeyId']) {
      expect(
        probeErrorMeansNameHeld('AWS::S3::Bucket', { name, $metadata: { httpStatusCode: 403 } }),
        name
      ).toBe(false);
    }
  });

  it('describes a bus move by the rule name, and a non-plain one without quoting it', () => {
    const change = {
      property: 'EventBusName',
      desiredName: 'busB',
      heldName: 'busA',
      heldProperty: 'EventBusName',
      physicalId: 'arn',
    };
    expect(renderReplacementNameChange(change, { Name: 'r' })).toBe(
      'The replacement moves rule "r" from bus "busA" to bus "busB", where another rule already holds that name'
    );
    expect(renderReplacementNameChange(change, { Name: 'a"b' })).toContain('the rule (by its Name)');
    const rename = { ...change, property: 'QueueName', desiredName: 'b', heldName: 'a' };
    expect(renderReplacementNameChange(rename, {})).toContain('asks for QueueName "b"');
  });

  it('derives a state machine ARN from any ARN of the old resource, or refuses', () => {
    const change = (physicalId: string) => ({
      property: 'StateMachineName',
      desiredName: 'sm',
      heldName: undefined,
      heldProperty: undefined,
      physicalId,
    });
    expect(
      replacementNameProbe({
        resourceType: 'AWS::StepFunctions::StateMachine',
        createdVia: 'sdk',
        change: change('arn:aws-cn:sns:cn-north-1:123456789012:t'),
        region: 'cn-north-1',
      })
    ).toEqual({ knownPhysicalId: 'arn:aws-cn:states:cn-north-1:123456789012:stateMachine:sm' });
    // The old ARN's region must be the stack's: another region, or none given, refuses.
    for (const region of ['us-east-1', undefined]) {
      expect(
        replacementNameProbe({
          resourceType: 'AWS::StepFunctions::StateMachine',
          createdVia: 'sdk',
          change: change('arn:aws-cn:sns:cn-north-1:123456789012:t'),
          region,
        })
      ).toBeNull();
    }
    // No region or account in the ARN (IAM, S3): nothing to derive from.
    expect(
      replacementNameProbe({
        resourceType: 'AWS::StepFunctions::StateMachine',
        createdVia: 'sdk',
        change: change('arn:aws:s3:::bucket'),
        region: 'us-east-1',
      })
    ).toBeNull();
  });
});
