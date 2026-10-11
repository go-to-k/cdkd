---
title: Provider reference
description: "Lookup page for cdkd provider authors: every member of the ResourceProvider interface and when to implement it, and the checklist of rules every provider obeys."
---

# Provider reference

This page is the lookup companion to
[Provider Development](provider-development.md), which walks through writing a
provider. Come here to find out what an interface member is for, to check your
provider against the rules before you open a pull request, or to fix a provider
that does not behave as you expect.

## The `ResourceProvider` interface

Every provider implements `ResourceProvider`. The interface is declared in
[`src/types/resource.ts`](https://github.com/go-to-k/cdkd/blob/main/src/types/resource.ts),
and that file documents every member.

`create`, `update` and `delete` are required. Every other member is optional,
and you implement it only when your resource type needs it:

| Member | Implement it when |
| --- | --- |
| `handledProperties` | Always, in practice. It routes resources to you and feeds the coverage test. |
| `unhandledByDesign` | A schema property is deliberately not sent |
| `import` | The type should be adoptable by `cdkd import` without an explicit id |
| `readCurrentState` | The type should take part in `cdkd drift` |
| `getAttribute` | An attribute may need a live read because state does not hold it |
| `removalDefaults`, `removalHandledInUpdate` | A removed property resets to a constant, or `update` already handles the removal |
| `getDriftUnknownPaths`, `getDriftUnorderedPaths`, `canonicalizeDriftProperties`, `canonicalizeDriftPair` | AWS reads a property back differently from how it was sent |
| `canonicalizeDesiredProperties` | The provider sends something narrower than what the template declares |
| `disableCcApiFallback` | Cloud Control cannot manage the type, so an unhandled property must be an error |
| `disableOuterRetry` | A retry by the engine would break per-call state the provider prepares |
| `getMinResourceTimeoutMs` | An operation on the type can outlast the default per-resource timeout |
| `isSameResource`, `resourceIdentity` | A failed create can leave an orphan under a name that can be reused |

`create` and `update` can also return two less common fields,
`effectiveProperties` and `noEchoAttributes`.
[Provider Development internals](provider-development-internals.md) describes
those two fields, the canonicalizers and the orphan identity methods.

## Rules every provider obeys

Go through this checklist before you open a pull request. The
[walkthrough](provider-development.md#provider-implementation-examples) shows
most of the rules in code. Each rule below links to its full statement, and the
second column says what goes wrong when the rule is broken.

### Errors and input

| Rule | What goes wrong otherwise |
| --- | --- |
| [Wrap every AWS call and rethrow as `ProvisioningError`](provider-rules.md#error-handling), with the original error as the cause | The failure reaches the user without the resource it belongs to |
| [Refuse a malformed value before any call](provider-rules.md#pre-flight-refusal-when-a-provider-may-reject-what-cloudformation-forwards), and [never infer a default from one](provider-rules.md#never-infer-a-default-from-a-possibly-malformed-value) | A typo deploys as a default nobody chose |
| [Respect the service's name length and character limits](provider-rules.md#resource-name-constraints) | Create fails for a long stack or logical id |
| [Send an idempotency token when create mints a server-side id](provider-rules.md#a-create-that-mints-a-server-side-id-needs-an-idempotency-token) | A retried create makes a second resource |

### Delete

| Rule | What goes wrong otherwise |
| --- | --- |
| [Treat "not found" on delete as success only after `assertRegionMatch`](provider-rules.md#idempotency) | A destroy in the wrong region empties state and orphans the resources |
| [Report a delete that made no AWS call as skipped](provider-rules.md#reporting-a-skipped-delete) | State drops a resource that is still running |

### Update

| Rule | What goes wrong otherwise |
| --- | --- |
| [Reset a property the template removed](provider-rules.md#update-removal-semantics-clear-on-removal) | AWS keeps the old value while `cdkd diff` reports no changes |
| [Do not erase AWS-authored values with a full-replace update](provider-rules.md#full-replace-update-apis-erase-aws-authored-values) | An update deletes configuration AWS or the service added |

### Attributes, properties and drift

| Rule | What goes wrong otherwise |
| --- | --- |
| [Return every `Fn::GetAtt` attribute, and build ARNs from the partition](provider-rules.md#returning-attributes) | References fail, or are wrong outside the `aws` partition |
| [Leave out an attribute you could not read](provider-development-internals.md#never-store-an-empty-string-placeholder-for-an-attribute-you-could-not-read-back). Never store `''` for it. | `Fn::GetAtt` resolves to an empty string |
| [Emit every user-settable property from `readCurrentState`](provider-rules.md#readcurrentstate-for-drift-detection) | A change made in the console is invisible to drift |
| [List every sent property in `handledProperties`](provider-rules.md#handledproperties-against-the-cfn-schema) | The resource is routed to Cloud Control, or a property is dropped |

### Region, startup and logging

| Rule | What goes wrong otherwise |
| --- | --- |
| Take the region from `ambientRegion()` and credentials from `getAwsClients()` or `ambientClientDefaults()` | A multi-region deploy calls the wrong region |
| Register only in `registerAllProviders`, and never import a provider module statically | Every command loads the SDK client at startup |
| Pass any log line that includes a resolved property value through `context.maskSecrets`, which `create` and `update` receive | A resolved secret is printed |

## A retry loop inside a provider must honor Ctrl-C

Most providers need no retry loop, because the deploy engine retries a failed
provider call itself. This rule applies when a provider calls `withRetry`
(`src/deployment/retry.ts`) on its own.

The engine checks for an interrupt between operations, and `withRetry` is the
only wait that checks during a backoff. But `withRetry` can only check when it
is given an interrupt watch. A provider that omits the watch leaves
{kbd:ctrl+c} with no effect until the retries run out. Pass the watch like
this:

```ts
const watch = startInterruptWatch(`... ${logicalId}`);
try {
  await withRetry(op, logicalId, {
    logger: this.logger,
    isInterrupted: watch.isInterrupted,
    onInterrupted: watch.onInterrupted,
  });
} finally {
  watch.dispose();
}
```

`startInterruptWatch` is in `src/provisioning/interrupt-watch.ts`. The task
`vp run audit:withretry-interrupt:check` fails on a `withRetry` call under
`src/provisioning/` that does not pass both options.

## A create that adopts an existing name

Some create APIs do not fail when the name is taken. They hand back the
existing resource, or overwrite it. `CreateQueue`, `CreateTopic`,
`PutMetricAlarm` and `PutRule` behave this way. A deploy must not record
another deployment's resource as its own, so such a type needs two more
methods.

Add the type to `NAME_ADOPTING_SDK_CREATE_TYPES`
(`src/deployment/replacement-name-holder/deploy-name.ts`) and implement:

| Method | Returns |
| --- | --- |
| `generatedCreateName(resourceType, logicalId, properties)` | The name `create()` sends when the template declares none, and `undefined` when it declares one |
| `lookupNames(resourceType, names, ctx)` | A `Map<name, physicalId>` of the names a resource already holds |

Three rules keep the check sound:

- **`create()` calls `generatedCreateName`**, so the name it sends and the
  name cdkd looks up cannot drift apart.
- **`lookupNames` reads by exact name**, in a batch call where the service
  has one and otherwise one read per name. It never lists: a listing is
  eventually consistent and can omit a resource created a moment ago.
- **A resource that is being deleted reads as absent**, and each API call
  goes through `withApiLimit` (`src/provisioning/name-lookup.ts`).

Without `lookupNames`, cdkd calls `import()` once per name. If the lookup
needs a property the plan cannot know yet, also implement
`lookupNeedsResolvedProperties`.

A deploy then refuses a create whose generated name another resource holds,
unless the stack's own records name that resource. See
[Name check before a create](state-store-name-check.md).
`tests/unit/deployment/generated-name-guard-types-4705.test.ts` checks that
every listed type has both methods.

## A provider that waits for stabilization

Some creates return before the resource is usable, so the provider polls until
the resource is ready. A user can change the waits with `--no-wait` and
`--full-wait`, which a provider sees as the environment variables
`CDKD_NO_WAIT` and `CDKD_FULL_WAIT`.

If your provider skips or lengthens its wait under either variable, document
the behaviour in two places: the wait table in [`cdkd deploy`](cli-deploy.md), and
the option's help text in `src/cli/options.ts`.

## Custom resources

You do not write a provider for a custom resource type, because the handler is
the user's own Lambda function. One existing provider serves all of them.

`CustomResourceProvider`
(`src/provisioning/providers/custom-resource-provider.ts`) handles `Custom::*`
and `AWS::CloudFormation::CustomResource`. It sends the handler the same
request CloudFormation would, with `RequestType` set to `Create`, `Update` or
`Delete`. From the handler's response it takes the physical id
(`PhysicalResourceId`) and the attributes (`Data`).

## When something does not work

### Your provider is not called

The resource went to Cloud Control. Run `cdkd diff MyStack` to see why: a
resource that was routed there because of a property is annotated
`[via CC API: <property>]`. There are three possible causes:

- the type is not registered,
- the template sets a property that is missing from `handledProperties`,
- state already records the resource as created through Cloud Control.

### `Fn::GetAtt` does not resolve

`create` or `update` did not return the attribute. Add it to the `attributes`
map both methods return, under the name CloudFormation documents.

### An update fails on a property that cannot change

The property is create-only, and the diff did not classify the change as a
replacement. The diff reads the type's entry in
`src/analyzer/replacement-rules.ts` first. For a property that entry does not
classify, it falls back to the `createOnlyProperties` of the type's
CloudFormation schema. Check both.

## Related

- [Provider Development](provider-development.md): the walkthrough
- [Provider implementation rules](provider-rules.md): the complete rulebook
- [Provider Development internals](provider-development-internals.md): the
  less common return fields and methods
