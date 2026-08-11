import { describe, it, expect, vi } from 'vite-plus/test';
import {
  configStringRefusal,
  readConfigString,
  requireConfigArray,
  requireConfigObject,
  requireConfigString,
} from '../../../src/provisioning/config-shape.js';

const PATH = 'AWS::S3::Bucket VersioningConfiguration';

describe('readConfigString', () => {
  describe('rule 1: an absent container defaults', () => {
    it('returns the fallback for undefined', () => {
      expect(readConfigString(undefined, 'Status', 'Suspended', PATH)).toBe('Suspended');
    });

    it('returns the fallback for null', () => {
      expect(readConfigString(null, 'Status', 'Suspended', PATH)).toBe('Suspended');
    });
  });

  describe('rule 2: a present-but-non-object container is refused', () => {
    // The headline shape of issue #1471: a string container indexed to
    // `undefined` and the `||` substituted the OPPOSITE of what the template
    // declared.
    it('refuses a string', () => {
      expect(() => readConfigString('Enabled', 'Status', 'Suspended', PATH)).toThrow(
        /VersioningConfiguration must be an object \(got a string\)/
      );
    });

    it('refuses an array', () => {
      // `typeof [] === 'object'`, so a container check that only tests typeof
      // waves this through.
      expect(() => readConfigString([{ Status: 'Enabled' }], 'Status', 'Suspended', PATH)).toThrow(
        /must be an object \(got an array\)/
      );
    });

    it('refuses a number and a boolean', () => {
      expect(() => readConfigString(1, 'Status', 'Suspended', PATH)).toThrow(/got a number/);
      expect(() => readConfigString(false, 'Status', 'Suspended', PATH)).toThrow(/got a boolean/);
    });

    it('names the container path, not the field, so the message points at the template', () => {
      expect(() => readConfigString('Enabled', 'Status', 'Suspended', PATH)).toThrow(
        /^AWS::S3::Bucket VersioningConfiguration must be an object/
      );
    });
  });

  describe('rule 3: an absent key defaults', () => {
    it('returns the fallback for an empty object', () => {
      // `VersioningConfiguration: {}` legitimately means Suspended.
      expect(readConfigString({}, 'Status', 'Suspended', PATH)).toBe('Suspended');
    });

    it('returns the fallback when the key is explicitly undefined', () => {
      expect(readConfigString({ Status: undefined }, 'Status', 'Suspended', PATH)).toBe('Suspended');
    });

    it('ignores unrelated keys', () => {
      expect(readConfigString({ Other: 'x' }, 'Status', 'Suspended', PATH)).toBe('Suspended');
    });
  });

  describe('rule 4: a present-but-unusable key is refused', () => {
    // Validating the container alone is not enough — each of these passes a
    // `typeof container === 'object'` check and still falls through to the
    // default.
    it('refuses null', () => {
      expect(() => readConfigString({ Status: null }, 'Status', 'Suspended', PATH)).toThrow(
        /VersioningConfiguration\.Status must be a non-empty string \(got null\)/
      );
    });

    it('refuses an empty string', () => {
      expect(() => readConfigString({ Status: '' }, 'Status', 'Suspended', PATH)).toThrow(
        /Status must be a non-empty string \(got a blank string\)/
      );
    });

    it('refuses a whitespace-only string', () => {
      expect(() => readConfigString({ Status: '   ' }, 'Status', 'Suspended', PATH)).toThrow(
        /got a blank string/
      );
    });

    it('refuses an unresolved intrinsic left as an object', () => {
      expect(() =>
        readConfigString({ Status: { Ref: 'SomeParam' } }, 'Status', 'Suspended', PATH)
      ).toThrow(/Status must be a non-empty string \(got an object\)/);
    });

    it('names the fallback so the user knows how to opt into the default', () => {
      expect(() => readConfigString({ Status: '' }, 'Status', 'Suspended', PATH)).toThrow(
        /Omit the field entirely to use the default \(Suspended\)/
      );
    });
  });

  describe('the happy path', () => {
    it('returns a well-formed value verbatim', () => {
      expect(readConfigString({ Status: 'Enabled' }, 'Status', 'Suspended', PATH)).toBe('Enabled');
    });

    it('does not trim the returned value', () => {
      // The blank check is about detecting a useless value, not normalizing a
      // real one — AWS is the authority on what a valid value looks like.
      expect(readConfigString({ Status: ' Enabled ' }, 'Status', 'Suspended', PATH)).toBe(
        ' Enabled '
      );
    });

    it('never leaks the offending value into the message', () => {
      // Config blocks can carry user data, so the message reports the TYPE
      // only. Asserted on a value distinctive enough to spot if it leaked.
      expect(() => readConfigString({ Status: 12345 }, 'Status', 'x', PATH)).toThrow(/got a number/);
      expect(() => readConfigString({ Status: 12345 }, 'Status', 'x', PATH)).not.toThrow(/12345/);
    });
  });
});

describe('requireConfigString', () => {
  // The value-level form used at TOP-LEVEL call sites, so the
  // `properties['X']` element-read stays visible to the
  // handled-property-wiring critic (see the JSDoc for why that matters).
  const PATH = 'AWS::WAFv2::WebACL Scope';

  it('returns the fallback for an absent value', () => {
    expect(requireConfigString(undefined, 'REGIONAL', PATH)).toBe('REGIONAL');
  });

  it('returns a well-formed value verbatim', () => {
    expect(requireConfigString('CLOUDFRONT', 'REGIONAL', PATH)).toBe('CLOUDFRONT');
  });

  it('refuses null, a blank string, and a non-string', () => {
    expect(() => requireConfigString(null, 'REGIONAL', PATH)).toThrow(
      /Scope must be a non-empty string \(got null\)/
    );
    expect(() => requireConfigString('  ', 'REGIONAL', PATH)).toThrow(/got a blank string/);
    expect(() => requireConfigString({ Ref: 'P' }, 'REGIONAL', PATH)).toThrow(/got an object/);
  });

  it('agrees with readConfigString on the field rules', () => {
    // The container form delegates to this one, so a divergence here would be
    // a real inconsistency between nested and top-level call sites.
    expect(() => readConfigString({ Scope: '' }, 'Scope', 'REGIONAL', 'AWS::WAFv2::WebACL')).toThrow(
      /AWS::WAFv2::WebACL\.Scope must be a non-empty string \(got a blank string\)/
    );
    expect(() => requireConfigString('', 'REGIONAL', 'AWS::WAFv2::WebACL.Scope')).toThrow(
      /AWS::WAFv2::WebACL\.Scope must be a non-empty string \(got a blank string\)/
    );
  });
});

describe('a blank value is legitimate when the fallback is itself blank', () => {
  // Rule 4 refuses a blank string because it silently takes the default. When
  // the default IS blank there is no divergence to hide, and an empty value is
  // a meaningful template input at exactly those sites — refusing it would
  // make this guard a regression for correct templates.
  it('accepts an empty LogFilePrefix (S3 logging: "no prefix")', () => {
    expect(readConfigString({ LogFilePrefix: '' }, 'LogFilePrefix', '', 'AWS::S3::Bucket LoggingConfiguration')).toBe('');
  });

  it('accepts an empty ExcludeCharacters (Secrets Manager: "exclude nothing")', () => {
    expect(
      requireConfigString('', '', 'AWS::SecretsManager::Secret GenerateSecretString.ExcludeCharacters')
    ).toBe('');
  });

  it('still refuses a NON-string at a blank-fallback site', () => {
    // The container/type guard is unaffected — only the blank-string rule is
    // relaxed, and only where blank equals the default.
    expect(() => requireConfigString(42, '', 'AWS::S3::Bucket LoggingConfiguration.LogFilePrefix')).toThrow(
      /must be a non-empty string \(got a number\)/
    );
    expect(() => requireConfigString(null, '', 'AWS::S3::Bucket LoggingConfiguration.LogFilePrefix')).toThrow(
      /got null/
    );
  });

  it('keeps refusing a blank value where the fallback is NOT blank', () => {
    // The versioning case must be unaffected: '' there really would flip to
    // the opposite meaning (Suspended).
    expect(() => requireConfigString('', 'Suspended', 'AWS::S3::Bucket VersioningConfiguration.Status')).toThrow(
      /must be a non-empty string/
    );
  });
});

describe('coerceNumber (issue #1513)', () => {
  // CloudFormation coerces scalars and cdkd does not, so an unquoted YAML
  // `IpProtocol: -1` arrives as a NUMBER and deploys fine today. Refusing it
  // would break a working template, so the numeric-looking sites coerce.
  const PATH = 'AWS::EC2::SecurityGroupIngress IpProtocol';

  it('stringifies a finite number', () => {
    expect(requireConfigString(-1, '-1', PATH, { coerceNumber: true })).toBe('-1');
    expect(requireConfigString(6, '-1', PATH, { coerceNumber: true })).toBe('6');
    expect(requireConfigString(0, '-1', PATH, { coerceNumber: true })).toBe('0');
  });

  it('refuses a NON-finite number — stringifying it would send "NaN" to AWS', () => {
    expect(() => requireConfigString(Number.NaN, '-1', PATH, { coerceNumber: true })).toThrow(
      /got a number/
    );
    expect(() =>
      requireConfigString(Number.POSITIVE_INFINITY, '-1', PATH, { coerceNumber: true })
    ).toThrow(/got a number/);
  });

  it('relaxes ONLY the number case — null, blanks, objects and booleans still refuse', () => {
    expect(() => requireConfigString(null, '-1', PATH, { coerceNumber: true })).toThrow(/got null/);
    expect(() => requireConfigString('  ', '-1', PATH, { coerceNumber: true })).toThrow(
      /got a blank string/
    );
    expect(() => requireConfigString({ Ref: 'P' }, '-1', PATH, { coerceNumber: true })).toThrow(
      /got an object/
    );
    expect(() => requireConfigString(true, '-1', PATH, { coerceNumber: true })).toThrow(
      /got a boolean/
    );
  });

  it('is opt-in: a number is still refused at an enum site', () => {
    expect(() => requireConfigString(5, 't3.micro', 'AWS::EC2::Instance InstanceType')).toThrow(
      /got a number/
    );
  });

  it('does not disturb the absent case', () => {
    expect(requireConfigString(undefined, '-1', PATH, { coerceNumber: true })).toBe('-1');
  });
});

describe('onUnusable (issue #1513)', () => {
  // The UPDATE-path form. `rollback-executor.ts` replays a rollback by calling
  // update() with a HISTORICAL cdkd state record as the desired bag, so a hard
  // refusal there can leave a resource un-rollbackable with no template-side
  // remedy — the state record cannot be fixed by editing the template.
  const PATH = 'AWS::IAM::AccessKey Status';

  it('warns and returns the fallback instead of throwing', () => {
    const warn = vi.fn();
    expect(requireConfigString(null, 'Active', PATH, { onUnusable: warn })).toBe('Active');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('says the value is ignored HERE and refused on create, so the split reads as a decision', () => {
    const warn = vi.fn();
    requireConfigString({ Ref: 'P' }, 'Active', PATH, { onUnusable: warn });
    const message = warn.mock.calls[0][0] as string;
    expect(message).toMatch(/AWS::IAM::AccessKey Status must be a non-empty string \(got an object\)/);
    expect(message).toMatch(/Ignoring it and using the default \(Active\) here/);
    // Wording must stay true on a replay CREATE too, not just an update.
    expect(message).toMatch(/REFUSED on a template-path create/);
  });

  it('stays silent for a well-formed value and for an absent one', () => {
    const warn = vi.fn();
    expect(requireConfigString('Inactive', 'Active', PATH, { onUnusable: warn })).toBe('Inactive');
    expect(requireConfigString(undefined, 'Active', PATH, { onUnusable: warn })).toBe('Active');
    expect(warn).not.toHaveBeenCalled();
  });

  it('composes with coerceNumber: a coercible value never reaches the warn', () => {
    const warn = vi.fn();
    expect(
      requireConfigString(1, '$LATEST', 'AWS::Lambda::EventInvokeConfig Qualifier', {
        coerceNumber: true,
        onUnusable: warn,
      })
    ).toBe('1');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('readConfigString container downgrade under onUnusable (issue #1544)', () => {
  // The nested-container form of the same replay downgrade: a malformed
  // CONTAINER (`StreamSpecification: ''`) under onUnusable warns and behaves
  // as `{}` — the key is then absent, so the fallback is returned, which is
  // exactly what an empty block already means.
  const PATH = 'AWS::DynamoDB::GlobalTable StreamSpecification';

  it('warns and returns the fallback for a malformed container', () => {
    const warn = vi.fn();
    expect(readConfigString('', 'StreamViewType', 'NEW_AND_OLD_IMAGES', PATH, { onUnusable: warn })).toBe(
      'NEW_AND_OLD_IMAGES'
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toMatch(/must be an object/);
    expect(message).toMatch(/Treating the block as empty/);
    expect(message).toMatch(/default \(NEW_AND_OLD_IMAGES\)/);
    expect(message).toMatch(/REFUSED on a template-path create/);
  });

  it('omits the parenthesized default when the fallback is the empty string', () => {
    const warn = vi.fn();
    expect(readConfigString(42, 'LogFilePrefix', '', 'AWS::S3::Bucket LoggingConfiguration', { onUnusable: warn })).toBe('');
    const message = warn.mock.calls[0][0] as string;
    expect(message).toMatch(/takes its default here/);
    expect(message).not.toMatch(/default \(\)/);
  });

  it('still throws on a malformed container when no onUnusable is supplied', () => {
    expect(() => readConfigString('', 'StreamViewType', 'NEW_AND_OLD_IMAGES', PATH)).toThrow(/must be an object/);
    expect(() => readConfigString('', 'StreamViewType', 'NEW_AND_OLD_IMAGES', PATH, {})).toThrow(/must be an object/);
  });

  it('threads the options into the FIELD half unchanged', () => {
    const warn = vi.fn();
    expect(
      readConfigString({ StreamViewType: null }, 'StreamViewType', 'NEW_AND_OLD_IMAGES', PATH, { onUnusable: warn })
    ).toBe('NEW_AND_OLD_IMAGES');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0] as string).toMatch(/StreamSpecification\.StreamViewType/);
  });
});

describe('requireConfigArray', () => {
  const LIST_PATH = 'AWS::S3::Bucket MetricsConfigurations[].TagFilters';

  it('passes an array through unchanged, with and without options', () => {
    const list = [{ Key: 'team', Value: 'alpha' }];
    expect(requireConfigArray(list, LIST_PATH)).toBe(list);
    expect(requireConfigArray(list, LIST_PATH, { onUnusable: vi.fn() })).toBe(list);
  });

  it('throws on a non-array when no onUnusable is supplied', () => {
    expect(() => requireConfigArray({ Key: 'k', Value: 'v' }, LIST_PATH)).toThrow(
      /must be an array \(got an object\)/
    );
    expect(() => requireConfigArray('team=alpha', LIST_PATH, {})).toThrow(/must be an array/);
  });

  it('warns and returns undefined under onUnusable (issue #1579 state-replay downgrade)', () => {
    const warn = vi.fn();
    expect(requireConfigArray('team=alpha', LIST_PATH, { onUnusable: warn })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toMatch(/must be an array/);
    expect(message).toMatch(/Leaving this configuration unapplied/);
    expect(message).toMatch(/REFUSED on a template-path create/);
  });
});

describe('requireConfigObject (issue #1581)', () => {
  const CONTAINER_PATH = 'AWS::S3::Bucket LifecycleConfiguration.Rules[].Filter';

  it('passes a plain object through unchanged, with and without options', () => {
    const container = { Prefix: 'logs/' };
    expect(requireConfigObject(container, CONTAINER_PATH)).toBe(container);
    expect(requireConfigObject(container, CONTAINER_PATH, { onUnusable: vi.fn() })).toBe(container);
  });

  it('passes an EMPTY object through — `{}` is a legitimate container', () => {
    const container = {};
    expect(requireConfigObject(container, CONTAINER_PATH)).toBe(container);
  });

  it('throws on a non-object when no onUnusable is supplied', () => {
    expect(() => requireConfigObject('logs/', CONTAINER_PATH)).toThrow(
      /must be an object \(got a string\)/
    );
    expect(() => requireConfigObject(42, CONTAINER_PATH, {})).toThrow(
      /must be an object \(got a number\)/
    );
  });

  it('refuses an ARRAY — the shape a `typeof === object` check would wave through', () => {
    expect(() => requireConfigObject([{ Prefix: 'logs/' }], CONTAINER_PATH)).toThrow(
      /must be an object \(got an array\)/
    );
  });

  it('refuses null / undefined — the ABSENT case belongs to the caller', () => {
    // Unlike `readConfigString`, which owns rule 1, this guard is reached only
    // behind the caller's own `!= null` test, so an absent value arriving here
    // is a caller bug rather than an omitted template block.
    expect(() => requireConfigObject(undefined, CONTAINER_PATH)).toThrow(/must be an object/);
    expect(() => requireConfigObject(null, CONTAINER_PATH)).toThrow(/must be an object/);
  });

  it('warns and returns undefined under onUnusable (state-replay downgrade)', () => {
    const warn = vi.fn();
    expect(requireConfigObject('logs/', CONTAINER_PATH, { onUnusable: warn })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toMatch(/must be an object/);
    expect(message).toMatch(/Leaving this configuration unapplied/);
    expect(message).toMatch(/REFUSED on a template-path create/);
  });
});

describe('configStringRefusal (issue #1595)', () => {
  // The SKIP-unit probe: asks the question `readConfigString` asks, without
  // taking its warn-and-DEFAULT answer, so a caller whose correct replay
  // downgrade is a SKIP can front the read without re-deriving the predicate.
  const P = 'AWS::S3::Bucket LifecycleConfiguration.Rules[]';

  it('is undefined for an ABSENT container and an ABSENT key', () => {
    // Both legitimately mean "defaulted" — the probe must not manufacture a
    // skip where the read would have succeeded.
    expect(configStringRefusal(undefined, 'Status', 'Enabled', P)).toBeUndefined();
    expect(configStringRefusal(null, 'Status', 'Enabled', P)).toBeUndefined();
    expect(configStringRefusal({}, 'Status', 'Enabled', P)).toBeUndefined();
  });

  it('is undefined for a usable value', () => {
    expect(configStringRefusal({ Status: 'Disabled' }, 'Status', 'Enabled', P)).toBeUndefined();
  });

  it('reports the CONTAINER refusal, with no action clause attached', () => {
    const refusal = configStringRefusal('logs/', 'Status', 'Enabled', P);
    expect(refusal).toMatch(/^AWS::S3::Bucket LifecycleConfiguration\.Rules\[\] must be an object/);
    // The caller supplies its own clause; inheriting the helper's would claim
    // a default this path never takes.
    expect(refusal).not.toMatch(/default/);
  });

  it('reports the FIELD refusal, naming the full key path', () => {
    const refusal = configStringRefusal({ Status: 1 }, 'Status', 'Enabled', P);
    expect(refusal).toMatch(
      /^AWS::S3::Bucket LifecycleConfiguration\.Rules\[\]\.Status must be a non-empty string/
    );
    expect(refusal).not.toMatch(/default/);
  });

  it('honors the SAME per-site relaxations as the read it fronts', () => {
    expect(configStringRefusal({ N: 1 }, 'N', 'x', P, { coerceNumber: true })).toBeUndefined();
    expect(configStringRefusal({ N: 1 }, 'N', 'x', P)).toBeDefined();
    // A blank value with a blank default is a legitimate template input.
    expect(configStringRefusal({ Prefix: '' }, 'Prefix', '', P)).toBeUndefined();
    expect(configStringRefusal({ Prefix: '' }, 'Prefix', 'logs/', P)).toBeDefined();
  });

  it('agrees with readConfigString on EVERY value — the anti-drift fence', () => {
    // This is the whole reason the probe delegates instead of hand-rolling a
    // `typeof` twin. A guard that disagrees with the chain it fronts refuses
    // where the read would have succeeded (or waves through where it would
    // have thrown) on exactly the interesting values — the blank string, the
    // explicit null, the coerced number.
    const values: unknown[] = [
      undefined,
      null,
      'Enabled',
      '',
      '   ',
      0,
      1,
      true,
      [],
      ['Enabled'],
      {},
      { nested: true },
    ];
    // `JSON.stringify`, NOT `String`: `String([])` and `String('')` are both
    // `''`, and `String(['Enabled'])` equals `String('Enabled')`, so a real
    // divergence on those rows would print two identical strings and read as
    // an assertion bug rather than as the predicate drift it is.
    const label = (v: unknown) => (v === undefined ? 'undefined' : JSON.stringify(v));
    for (const fallback of ['Enabled', '']) {
      for (const options of [undefined, { coerceNumber: true }]) {
        for (const value of values) {
          const refused = configStringRefusal({ Status: value }, 'Status', fallback, P, options);
          let threw = false;
          try {
            readConfigString({ Status: value }, 'Status', fallback, P, options);
          } catch {
            threw = true;
          }
          const where = `value=${label(value)} fallback=${label(fallback)} opts=${label(options)}`;
          expect(`${where} refused=${refused !== undefined}`).toBe(`${where} refused=${threw}`);
        }
      }
      // ...and the CONTAINER half, which the loop above cannot reach.
      for (const container of [undefined, null, 'logs/', 42, [], {}]) {
        const refused = configStringRefusal(container, 'Status', fallback, P);
        let threw = false;
        try {
          readConfigString(container, 'Status', fallback, P);
        } catch {
          threw = true;
        }
        const where = `container=${label(container)} fallback=${label(fallback)}`;
        expect(`${where} refused=${refused !== undefined}`).toBe(`${where} refused=${threw}`);
      }
    }
  });
});
