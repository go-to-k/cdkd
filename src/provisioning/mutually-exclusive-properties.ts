/**
 * Pre-flight rule: top-level CFn properties that are MUTUALLY EXCLUSIVE.
 *
 * CloudFormation rejects some property COMBINATIONS that each property on its
 * own is perfectly valid in. cdkd already refuses whole TYPES
 * ({@link ./unsupported-types}) and individual PROPERTIES
 * ({@link ./property-coverage}) at deploy pre-flight; this module is the same
 * layer for the combination case (issue
 * [#1634](https://github.com/go-to-k/cdkd/issues/1634)).
 *
 * ## Why pre-flight rather than the provider
 *
 * A provider-side refusal only fires on a template-borne CREATE. For a stack
 * that ALREADY has the resource, the deploy diff classifies NO_CHANGE, the
 * provider is never called, and the refusal is unreachable — which is exactly
 * how the `AWS::EC2::Route` multi-destination case (#1566 / #1591) could stay
 * in a template indefinitely. Pre-flight runs on the desired template on every
 * deploy, so it does not depend on the resource being new, nor on a provider
 * happening to implement `canonicalizeDesiredProperties`.
 *
 * ## The unresolved-intrinsic constraint
 *
 * Pre-flight runs BEFORE intrinsic resolution (see `.claude/rules/providers.md`
 * and the `validateResourceProperties` call site in
 * `src/deployment/deploy-engine.ts`), so a legitimate template can carry BOTH
 * keys with one of them behind an `Fn::If` that resolves to `AWS::NoValue`:
 *
 * ```yaml
 * DestinationCidrBlock:     !If [IsV4, "10.0.0.0/8", !Ref "AWS::NoValue"]
 * DestinationIpv6CidrBlock: !If [IsV4, !Ref "AWS::NoValue", "::/0"]
 * ```
 *
 * The resolver omits a property that resolves to `AWS::NoValue`
 * (`intrinsic-function-resolver.ts`), so exactly one of those reaches AWS and
 * the template is VALID. An unresolved intrinsic is therefore counted as
 * `unknown`, never as `declared` — the check refuses only on two or more keys
 * that are unconditionally present. That is the fail-SAFE direction: a
 * combination this module lets through is still caught by the provider's own
 * create-path refusal, whereas a false refusal would block a valid deploy with
 * no escape hatch.
 *
 * ## No override flag, by design
 *
 * `--allow-unsupported-types` / `--allow-unsupported-properties` exist because
 * those refusals are about a gap in CDKD. A mutually-exclusive violation is a
 * gap in the TEMPLATE — CloudFormation and the service API reject it too — so
 * there is nothing to opt into, and the remedy (delete the extra key) is always
 * available to the user.
 *
 * ## Adding a rule
 *
 * Only add a combination that AWS itself rejects, and record the evidence in
 * `rationale`. A wrong rule here refuses a VALID template with no way around
 * it, so an unverified combination belongs in a provider warning, not in this
 * table.
 */

/**
 * One set of top-level property names of which at most ONE may be declared on
 * a single resource.
 */
export interface MutuallyExclusiveRule {
  /**
   * The mutually exclusive property names, in the order the message lists
   * them — for a type whose provider resolves the winner by a `||` chain
   * (`AWS::EC2::Route`), this is that chain's precedence order, so
   * `declared[0]` names the key AWS would actually receive.
   */
  readonly properties: readonly string[];
  /** Why AWS rejects the combination. Quoted verbatim in the pre-flight error. */
  readonly rationale: string;
  /**
   * When true, the message names `declared[0]` as the key that would reach AWS
   * — only correct for a type whose provider narrows to the first declared key
   * rather than failing outright.
   */
  readonly firstDeclaredWins?: boolean;
}

/**
 * The rule table, keyed by CFn resource type.
 *
 * Deliberately seeded with the ONE combination this repo has verified end to
 * end (`AWS::EC2::Route`, refused by `EC2Provider.createRoute` since #1566 and
 * normalized on both diff sides since #1591). The mechanism is general; the
 * data is not speculative. See "Adding a rule" above.
 */
export const MUTUALLY_EXCLUSIVE_PROPERTIES: ReadonlyMap<string, readonly MutuallyExclusiveRule[]> =
  new Map<string, readonly MutuallyExclusiveRule[]>([
    [
      'AWS::EC2::Route',
      [
        {
          // Kept in sync with `ROUTE_DESTINATION_KEYS` in
          // `src/provisioning/providers/ec2-provider.ts` (module-private there).
          // `tests/unit/provisioning/mutually-exclusive-properties.test.ts`
          // pins every name in this table against the CFn schema fixtures, so a
          // rename on either side is caught by a failing test rather than by a
          // silently dead rule.
          properties: [
            'DestinationCidrBlock',
            'DestinationIpv6CidrBlock',
            'DestinationPrefixListId',
          ],
          rationale:
            'CloudFormation and the EC2 CreateRoute API accept exactly one destination per route.',
          firstDeclaredWins: true,
        },
      ],
    ],
  ]);

/**
 * A single resource's violation of a single rule.
 */
export interface MutuallyExclusiveViolation {
  readonly resourceType: string;
  readonly rule: MutuallyExclusiveRule;
  /** The rule's properties this resource declares — always length >= 2, in rule order. */
  readonly declared: string[];
}

/**
 * True for a single-key object whose key is `Ref` or `Fn::*` — the shape of an
 * unresolved CloudFormation intrinsic. Mirrors `isIntrinsicShaped` in
 * {@link ./create-only-properties}; kept local because the two modules answer
 * different questions about the shape and should not drift into one another's
 * behavior by accident.
 */
function isUnresolvedIntrinsic(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::'));
}

/**
 * True when `value` is unconditionally present in the template.
 *
 * The predicate is `Boolean`, not a hand-listed `undefined | null | ''` set,
 * matching `narrowRouteDestinations`' truthiness narrowing in
 * `ec2-provider.ts`: the property bag is `unknown`-valued at runtime, so an
 * unquoted YAML `0` must be skipped here exactly as the provider's `||` chain
 * skips it — otherwise pre-flight refuses a template the provider would have
 * accepted. An unresolved intrinsic is truthy but its resolved presence is
 * NOT yet known, so it is excluded ahead of the truthiness test.
 */
function isDeclared(value: unknown): boolean {
  if (isUnresolvedIntrinsic(value)) return false;
  return Boolean(value);
}

/**
 * Find every mutually-exclusive rule this resource violates.
 *
 * Returns `[]` for a type with no rules, an absent property bag, and any
 * combination that is only reached through an unresolved intrinsic.
 */
export function findMutuallyExclusiveViolations(
  resourceType: string,
  templateProperties: Record<string, unknown> | undefined
): MutuallyExclusiveViolation[] {
  if (!templateProperties) return [];
  const rules = MUTUALLY_EXCLUSIVE_PROPERTIES.get(resourceType);
  if (!rules) return [];

  const violations: MutuallyExclusiveViolation[] = [];
  for (const rule of rules) {
    const declared = rule.properties.filter((property) => isDeclared(templateProperties[property]));
    if (declared.length > 1) violations.push({ resourceType, rule, declared });
  }
  return violations;
}

/**
 * Render one violation as a per-resource error line.
 *
 * For a `firstDeclaredWins` rule the message names the key that WOULD reach
 * AWS, because that turns the remedy from a guess into a safe edit: deleting
 * the other keys cannot change the deployed resource, since the service was
 * never sent them.
 */
export function buildMutuallyExclusiveMessage(
  logicalId: string,
  violation: MutuallyExclusiveViolation
): string {
  const { resourceType, rule, declared } = violation;
  const winnerNote = rule.firstDeclaredWins
    ? ` Only ${declared[0]} would reach AWS, so removing ${declared.slice(1).join(' / ')} leaves the intended resource unchanged.`
    : '';
  return (
    `  - ${logicalId} (${resourceType}) declares ${declared.join(' and ')}\n` +
    `      ${rule.rationale}${winnerNote}\n` +
    `      Declare at most one of: ${rule.properties.join(' / ')}`
  );
}
