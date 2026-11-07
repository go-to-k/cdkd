/**
 * Fingerprints of the UNRESOLVED template expression behind a property that
 * state records as the secret mask (go-to-k/cdkd#4451).
 *
 * A property whose resolved value carries a mask-only needle (the CDK EC2
 * `UserData` shape: `Fn::Base64` over a script embedding a `{{resolve:...}}`
 * reference, go-to-k/cdkd#2759) is persisted as `***`. The mask identifies
 * nothing, so the deploy's no-change skip and the diff compared `***` with
 * `***`, and an edit around the reference, or a retarget of it, was never
 * sent. The record keeps, per such property, a hash of the TEMPLATE value it
 * was written from: an edit around the reference (or a retarget of it) moves
 * the hash and the property is updated, while a rotated secret behind an
 * unchanged template does not, as in CloudFormation. An input that changes
 * WITHOUT the template text changing (a parameter value, a replaced
 * resource's `Ref`, a flipped condition) moves the INPUT fingerprint
 * (go-to-k/cdkd#4543, below).
 *
 * TWO FIELDS.
 * - `maskedPropertyFingerprints` (`sha256:`, {@link maskedPropertyFingerprint}):
 *   the template value's TEXT, exactly as #4451 wrote it, so an older cdkd
 *   still reads it and still sends a template edit.
 * - `maskedPropertyInputFingerprints` (`inputs-sha256:<hex>+sha256:<hex>`,
 *   {@link maskedInputFingerprint}): the template value with each NON-SECRET
 *   input replaced by what it resolved to (a parameter's bound value, a
 *   `Ref` / `Fn::GetAtt` result, the branch an evaluated condition selects),
 *   then the text hash it is BOUND to. A `NoEcho` parameter, a
 *   `{{resolve:...}}` reference, and any input derived from one stay in their
 *   UNRESOLVED (template) form: the hash is computed from no secret value, so
 *   it is no confirm oracle (`.claude/rules/layout-deployment-secrets.md`).
 *   The classes are in {@link parameterInputsFor} and `inputForm` below.
 *   Non-`NoEcho` parameter values and cross-stack outputs are treated as
 *   public, so a low-entropy one may be recoverable from the hash: declare a
 *   sensitive one `NoEcho`.
 *
 * The one way a secret can still reach either hash is a template LITERAL
 * equal to a `NoEcho` parameter's value or to a value the same resource
 * resolved as a secret; such a property is refused a hash
 * ({@link REFUSED_FINGERPRINT}) and keeps the pre-#4451 comparison. The
 * parameter values are known from deploy start (backfill and every save); a
 * resolved value only to a save that resolved the resource.
 *
 * COMPATIBILITY. A record with no text fingerprint for a masked property
 * (every record a pre-#4451 cdkd wrote) is compared exactly as before. The
 * deploy backfills it from the template it deploys, the same template the
 * unchanged comparison has just accepted, so the FIRST deploy under this
 * version sends what it sent before, and a later edit is detected. A property
 * with a text fingerprint but no bound input fingerprint (a #4451 record, or
 * one an older cdkd rewrote: it carries the input field untouched, so the
 * binding breaks) is compared as text; while the text matches, the deploy's
 * diff RE-BASELINES its input fingerprint from today's inputs without
 * sending anything.
 */
export {
  REFUSED_FINGERPRINT,
  maskedPropertyFingerprint,
} from './masked-property-fingerprints/core.js';
export { parameterInputsFor } from './masked-property-fingerprints/input-walk.js';
export type {
  ParameterInput,
  MaskedInputSources,
  NestedTemplate,
  ChildTemplateLoader,
} from './masked-property-fingerprints/input-walk.js';
export {
  nestedStackOutputClass,
  maskedInputFingerprint,
  classifyPassedParameters,
  recordPassedParameterClasses,
  passedParameterClassesOf,
} from './masked-property-fingerprints/nested-outputs.js';
export type {
  NestedOutputClass,
  PassedParameterClass,
} from './masked-property-fingerprints/nested-outputs.js';
export {
  inputFingerprinter,
  possiblyMaskedKeys,
  maskedInputFingerprintsFor,
  maskedPropertyFingerprintsFor,
  maskedPropertyFingerprintsOf,
  maskedPropertyInputFingerprintsOf,
  movedMaskedProperties,
  withRebaselinedFingerprints,
  isWrittenFromDeployedTemplate,
  markWrittenFromDeployedTemplate,
  withMaskedPropertyFingerprints,
  backfillMaskedPropertyFingerprints,
} from './masked-property-fingerprints/records.js';
export type { InputFingerprinter } from './masked-property-fingerprints/records.js';
