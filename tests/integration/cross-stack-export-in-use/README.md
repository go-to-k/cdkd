# cross-stack-export-in-use

A producer deploy that changes or removes an export a consumer still imports
via `Fn::ImportValue` is refused before any resource change, as CloudFormation
refuses it ([#6088](https://github.com/go-to-k/cdkd/issues/6088)). The same
change deployed together with its consumer (`deploy --all`) goes through,
including the "deadly embrace" case where the consumer drops its reference and
the producer drops the resource in one run.

Run: `/run-integ cross-stack-export-in-use`
