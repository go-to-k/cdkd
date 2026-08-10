import { describe, it, expect, vi } from 'vite-plus/test';
import { readConfigString, requireConfigString } from '../../../src/provisioning/config-shape.js';

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
    expect(message).toMatch(/Ignoring it and using the default \(Active\) for this update/);
    expect(message).toMatch(/REFUSED on create/);
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
