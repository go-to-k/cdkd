---
title: "Deploy: custom resources"
description: "How cdkd deploy handles a custom resource whose ServiceToken changed, and what to do when it skipped a custom-resource delete."
---

# Deploy: custom resources

A custom resource is a resource whose create, update and delete are carried
out by a handler you supply, usually a Lambda function. The resource's
`ServiceToken` property is the handler's ARN. This page covers the two
situations where `cdkd deploy` treats a custom resource differently from other
resources: the `ServiceToken` changed, or cdkd could not send the delete.

## A changed custom-resource ServiceToken

`cdkd deploy` refuses to change a custom resource's `ServiceToken` in place.
CloudFormation refuses it too, with `Modifying service token is not allowed`.

The reason is that the handler owns whatever it created. If cdkd sent the
change as an update, only the new handler would hear about it. The old handler
would never receive a delete for what it created.

### How to move a custom resource to another handler

Give the resource a new logical id. In CDK that means a new construct id:

```ts
// Before:
// new CustomResource(this, 'Seed', { serviceToken: oldProvider.serviceToken });
new CustomResource(this, 'SeedV2', { serviceToken: newProvider.serviceToken });
```

The deploy then creates the new resource through the new handler and deletes
the old resource through its old handler. Calling `overrideLogicalId` on the
resource's `CfnResource` has the same effect.

No flag overrides the refusal. A resource named by `--recreate-via-cc-api` is
not refused, because that flag already deletes the old resource through the
recorded token and creates the new one through the template's.

### When the refusal happens

cdkd compares the token recorded in state with the token in the new template.
A `Ref` or `Fn::GetAtt` whose ARN did not change is not a change. Otherwise,
when the refusal happens depends on what cdkd can compare.

**The two tokens are different ARNs.** cdkd refuses before anything is
provisioned, and `--dry-run` refuses as well. No handler is called and state
is unchanged.

**The new token reads a resource that this deploy creates or replaces.** A
renamed Lambda function behind the custom resource, or a switch to a new
provider, is this case. cdkd refuses once that resource exists, before it
invokes the handler. The deploy fails and rolls back.

If the deploy was replacing the Lambda function, cdkd has already deleted the
old function by then, and the rollback creates it again from its record. If
that fails, or the function comes back under another name, the custom
resource's record names a function that no longer exists.

**The recorded token cannot be compared.** The recorded token is missing, or
it is the mask `***`, or it is a `{{resolve:...}}` reference. cdkd cannot
compare, so it refuses a deploy whose template changes the token.

If the handler did not change, edit `state.json` and put the ARN of the
handler that created the resource back as `ServiceToken`, then deploy again.
Use the ARN the resource was last deployed with. The ARN that the template
names now may be a different one.

**The token comes from a `NoEcho` parameter.** cdkd records such a token only
as `***`. A new parameter value is therefore not detected, and the update goes
to whichever handler the new value names. To have such a change refused, feed
`ServiceToken` from a plain value.

## A skipped custom-resource delete

A deploy deletes a custom resource when the resource leaves the template, is
replaced, or is rolled back. To delete it, cdkd invokes the handler. cdkd
skips the delete, as `cdkd destroy` does, in three cases:

- the handler answers `FAILED`;
- the invoke does not complete;
- the recorded `ServiceToken` is the mask `***` or a `{{resolve:...}}`
  reference.

What follows depends on why the resource was being deleted.

| Situation | Result |
| --- | --- |
| Removed from the template | The record is kept and the deploy exits `2`. |
| Replaced delete-first, or rolled back | The resource usually fails and the record is kept. |
| The other copy already exists | The skip only warns, and the surviving copy is no longer tracked. |

The third row covers a replacement that created the new resource first, and a
rollback that created the old resource again first. Tear the surviving copy
down by hand.

### A resource removed from the template

The next `cdkd deploy` sends the delete again. Before you run it, fix the
handler, or edit `state.json` and put the provider's ARN back as
`ServiceToken`.

If the handler's Lambda function no longer exists by then, that deploy drops
the record with a warning, and you tear down what the handler managed by hand.

`--allow-unaddressed` lets a deploy exit `0` in the meantime. `cdkd rollback`
has no such flag.

### Giving up on the delete

To stop tracking a resource that was removed from the template, drop only its
record:

```bash
cdkd state orphan MyStack --stack-region us-east-1 --resource SeedResource
```

See [one resource's record](cli-state-writing.md#removing-one-resource-from-the-record).

> [!CAUTION]
> Do not run `cdkd state orphan MyStack` without `--resource` here. It drops
> the record of every resource in the stack, so the next deploy creates them
> all again or collides with them. The whole-stack form is the remedy only on
> [`cdkd destroy`](cli-destroy.md), where the other records are already gone.

### A `ServiceToken` that is not a string

A `ServiceToken` can end up as something other than a string, such as an
intrinsic function that was not resolved. The fix depends on the operation,
because each operation reads the token from a different place.

| Operation | Reads the token from | Fix |
| --- | --- | --- |
| Create or update | The template | Fix the template and deploy again. |
| Rollback | The recorded value | Fix the template and deploy again. |
| Delete | The state record | Restore the ARN in `state.json`, or drop only that record with `--resource`. |

For a create, an update or a rollback, do not drop the record. Dropping the
record of a resource that the template still declares makes the next deploy
send the handler a new create.

## Related

- [`cdkd state`](cli-state.md): dropping one resource's record
- [Destroy flags & guards](cli-destroy.md): the same skip on `cdkd destroy`
- [`cdkd diff`](cli-diff.md): previewing what a deploy would change
- [Deploy: waits & concurrency](cli-deploy.md): every deploy flag
