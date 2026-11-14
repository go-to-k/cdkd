import { GetParameterCommand, ParameterNotFound } from '@aws-sdk/client-ssm';
import { definedAttributes } from '../../attribute-map.js';
import {
  displayIdent,
  isPasteableIdent,
  SECRET_REF_MAX_CODE_POINTS,
} from '../../../utils/display-safe.js';
import { commandHole } from '../../../utils/pasteable-command.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { remedyLogicalId, resolveExplicitPhysicalId } from '../../import-helpers.js';
import { renderDisableCommand } from '../../replacement-protection-advice.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';
import type { SSMParameterProvider } from '../ssm-parameter-provider.js';

/**
 * Refuse a physical id SSM's WRITE APIs could never accept (issue #1824
 * review round 3).
 *
 * An SSM parameter's physicalId must always be the parameter NAME, because
 * that is the only thing the write APIs take. `PutParameterRequest.Name`:
 * "You can't enter the Amazon Resource Name (ARN) for a parameter, only the
 * parameter name itself", with a name charset of `a-zA-Z0-9_.-` plus `/` as
 * the hierarchy separator; `DeleteParameterRequest.Name` repeats the ARN
 * prohibition verbatim. A COLON therefore cannot appear in any writable name,
 * which is the single predicate used here — it covers both shapes
 * `GetParameter` additionally accepts and this method has to stop:
 *
 *  - an ARN (`arn:aws:ssm:us-east-1:111122223333:parameter/foo`), and
 *  - a version / label SELECTOR (`GetParameterRequest.Name`: "To query by
 *    parameter label, use `"Name": "name:label"`. To query by parameter
 *    version, use `"Name": "name:version"`").
 *
 * Both sail through this provider's existence check, so before this guard the
 * value was RECORDED as the physicalId and the damage landed later and
 * elsewhere: `cdkd deploy` failing at `PutParameter({Name: physicalId})` with
 * a `ValidationException` after a `Value` change, and `cdkd destroy` failing
 * identically at `DeleteParameter`. This is where the bad value ENTERS
 * (`--resource` / `Properties.Name`), so it is where it is stopped.
 *
 * REFUSED, NOT NORMALIZED to the name, and the ARN grammar is the reason. The
 * mapping back is genuinely ambiguous rather than merely awkward:
 *
 *  - The leading `/` is NOT recoverable. `arn:…:parameter/foo` is the ARN of
 *    BOTH the simple name `foo` and the one-level hierarchical name `/foo`,
 *    since the name's leading slash IS the separator — `aws-cdk-lib`'s
 *    `arnForParameterName` renders the two to the identical string, and that
 *    is precisely why CDK needs an explicit `simpleName` flag whenever the
 *    name is a token. SSM stores a one-level `/foo` as `foo`, so both name
 *    the same parameter (measured, go-to-k/cdkd#6272), but the spelling is
 *    what the record's Ref returns, and the ARN cannot say which one the
 *    template's consumers expect.
 *  - A parameter SHARED from another account has no name form at all
 *    ("For parameters shared with you from another account, you must use the
 *    full ARN"), so for that shape there is nothing to normalize TO.
 *
 * A refusal is a loud, fixable error, and the message names the exact command
 * that prints the name to pass instead.
 */
export function refuseUnwritableParameterId(
  this: SSMParameterProvider,
  input: ResourceImportInput,
  explicit: string
): void {
  if (!explicit.includes(':')) return;

  const isArn = explicit.startsWith('arn:');
  const shape = isArn ? 'an ARN' : 'a version / label selector';
  // The `--resource` fragment is a span the operator PASTES, so it takes the
  // pasteable rule (go-to-k/cdkd#3436, the checkbox the #3269 lane left for
  // it), not the prose one: the logical id is template-controlled, and
  // `--resource` splits its value on the FIRST `=`, so an id carrying `=`
  // retargets the flag while one carrying `'` or a space reshapes the pasted
  // line. It is named only when `isPasteableIdent` admits it -- the same
  // predicate `export.ts`'s `importRepairCommand` applies to the same flag --
  // and holed otherwise; `shellQuote` is NOT the alternative, since a quoted
  // `'a=b'` still reaches Commander as `a=b` and still splits. The
  // placeholder is `commandHole`'s quoted form: bare, `<parameterName>` was
  // two redirections the moment the sentence after it was pasted with it.
  const resourceArg = `${remedyLogicalId(input.logicalId)}=` + commandHole('parameterName');
  const remedy =
    input.knownPhysicalId === explicit
      ? `pass the parameter NAME instead: --resource ${resourceArg}`
      : `set Properties.Name to the parameter NAME rather than ${shape}`;
  // The ARN case is the one with a derivation a reader may expect cdkd to
  // perform, so only it carries the why-not note.
  const whyNotDerived = isArn
    ? ' cdkd deliberately does NOT derive the name from the ARN: the leading "/" is not ' +
      'recoverable (arn:...:parameter/foo is the ARN of BOTH the simple name "foo" and the ' +
      'hierarchical name "/foo"), and a parameter shared from another account has no name ' +
      'form at all — so a derived name could silently address a DIFFERENT parameter.'
    : '';

  // The pasteable half goes through the shared sanitize / shell-quote /
  // SUPPRESS (issue #3136, the #2669 shape). `explicit` is the `--resource`
  // override or the template's `Properties.Name`, so it is USER-controlled
  // text on its way into a command this message tells the operator to run.
  // A value sanitizing to something DIFFERENT gets no command at all: it
  // would read a different parameter, which is worse than naming none.
  //
  // NO masker is threaded, and that is a fact about the PATH rather than an
  // omission: `import()` takes a `ResourceImportInput`, which carries no
  // `maskSecrets`, and `cdkd import` resolves no dynamic references, so
  // there is no secret bag for one to be built from. For the same reason
  // this message does NOT reach `deployments/{runId}.jsonl` — only
  // deploy / destroy / rollback start the run recorder, and `import` is the
  // only caller of `provider.import` (security review of issue #3136
  // corrected an earlier claim here that it did).
  // A block that displays an untrusted value carries no pasteable command
  // (go-to-k/cdkd#3950's S1 rule), and this block carries two: the read
  // command below and the `--resource` remedy. So `explicit` is shown, and
  // named in the read command, only when it is plain in `displayIdent`'s
  // sense (every character literal inside single quotes, no whitespace,
  // tested first so a value that IS `displayIdent`'s own cut output is
  // refused without resting on the marker's tail digest); otherwise it is
  // described and the console wording replaces the command. The logical id
  // follows the `--resource` fragment's own predicate, `isPasteableIdent`,
  // so it is either named in both or in neither. Displayed, a JSON-bounded `$( )`
  // value ran when the sentence was pasted into zsh, which the `(` around
  // it does not stop.
  const explicitPlain =
    !/\s/.test(explicit) &&
    displayIdent(explicit, { maxCodePoints: SECRET_REF_MAX_CODE_POINTS }) === explicit;
  const readCommand = explicitPlain
    ? renderDisableCommand({
        before: 'aws ssm get-parameter --name',
        identifier: explicit,
        after: '--query Parameter.Name --output text',
      })
    : '';
  const subject = isPasteableIdent(input.logicalId)
    ? `SSM parameter ${input.logicalId}`
    : 'an SSM parameter whose logical id is not a plain identifier';
  const shown = explicitPlain ? explicit : 'not shown: it is not a plain identifier';
  const howToRead = readCommand
    ? ` Read the name AWS holds with: ${readCommand}`
    : // The "via the console" wording the sibling sites use (`UNNAMEABLE_ID_CLAUSE`),
      // with its reasons spelled out: this value is user-supplied, so any of
      // them can fire here (go-to-k/cdkd#4238).
      ' Read the name AWS holds via the console: the value cdkd was given cannot be reproduced ' +
      'safely on a command line (sanitizing would change it, so a command would read a ' +
      'different parameter, or it holds a character or prefix a pasted shell line, or the ' +
      'AWS CLI itself, would act on).';
  throw new ProvisioningError(
    // The logical id and `explicit` are shown only when plain and described
    // otherwise (see `subject` / `shown` above). Neither ever sits inside a
    // hand-written `'...'` (go-to-k/cdkd#3950): a `'` in the value closed
    // that quote and left the rest of a pasted clause as bare shell. A plain
    // ARN is shown whole, at the ARN ceiling, so a legitimate one is never
    // cut.
    `Cannot adopt ${subject} from ${shape} (${shown}): cdkd records ` +
      `a parameter's NAME as its physical id, because SSM's write APIs accept only the name ` +
      `(PutParameter and DeleteParameter both reject an ARN, and a name cannot contain ':'), ` +
      `so the next cdkd deploy and cdkd destroy would fail with a ValidationException. ` +
      `${remedy}.${whyNotDerived}${howToRead}`,
    input.resourceType,
    input.logicalId
  );
}

/**
 * Adopt an existing SSM parameter into cdkd state.
 *
 * SSM physical IDs ARE the parameter names (`/foo/bar`). The CDK template
 * usually carries `Properties.Name` explicitly, so the explicit-name path
 * covers most cases.
 *
 * Lookup order:
 *  1. `--resource` override or `Properties.Name` → refuse it outright when it
 *     is not a writable NAME (see {@link refuseUnwritableParameterId} — note
 *     `GetParameter` accepts an ARN and a `name:version` selector while every
 *     write API rejects both), else verify via `GetParameter`.
 */
export async function importImpl(
  this: SSMParameterProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'Name');
  if (explicit) {
    this.refuseUnwritableParameterId(input, explicit);
    try {
      const resp = await this.ssmClient.send(new GetParameterCommand({ Name: explicit }));
      // Record `Arn` on the import path too (issue #1824): the state record an
      // import writes is what a later `Fn::GetAtt` reads, so leaving it empty
      // left an ADOPTED parameter hitting the same resolver shape-guard
      // hard-fail the create-side fix repairs. Unlike create / update this
      // needs no construction and no extra call — the existence-verification
      // `GetParameter` above ALREADY reports the authoritative ARN, so prefer
      // the value AWS holds over deriving one.
      const arn = resp.Parameter?.ARN;
      // Issue #3627: `Type` / `Value` too, the rest of the map `create()`
      // records; the resolver has no arm for them, so after an import they
      // resolved to the parameter NAME.
      //
      // `Value` ONLY when the template declares it as a plain literal.
      // `GetParameter` returns the PLAINTEXT a `{{resolve:...}}` dynamic
      // reference or a `Ref` to a NoEcho parameter put there, and nothing on
      // these paths holds a needle for it: the #1852 heal re-reads through
      // this method for an UNCHANGED record, whose scrub has no needles and
      // relies on the read itself returning nothing sensitive, and the import
      // scan's needles are only what THIS run resolved (a NoEcho parameter's
      // `Default`, a secret's current version). A literal cannot hide a
      // secret, so recording it is the `create()` parity. The heal passes the
      // record's already-redacted properties and import passes the
      // Ref-substituted template, and both keep a reference visible as either
      // an object or `{{resolve:` text. (`WithDecryption` stays off, so a
      // `SecureString` adopted via `--resource` would yield ciphertext, never
      // plaintext; CloudFormation cannot create one.)
      const declared = input.properties?.['Value'];
      const literalValue = typeof declared === 'string' && !declared.includes('{{resolve:');
      return {
        physicalId: explicit,
        attributes: definedAttributes({
          Type: resp.Parameter?.Type,
          ...(literalValue && { Value: resp.Parameter?.Value }),
          Arn: arn,
        }),
      };
    } catch (err) {
      if (err instanceof ParameterNotFound) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // DescribeStackResources or the template's physical-name property; a
  // parameter reaching here needs an explicit `--resource` override.
  return null;
}
