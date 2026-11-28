# AppSync schema update and drift

Exercises `AWS::AppSync::GraphQLSchema` on the SDK route (Refs #7127, #7139).
One GraphQL API with IAM auth, a None data source and JS resolvers; no key and
no backing store. A second API (`S3Api` / `S3Schema`) is an L1
`CfnGraphQLSchema` sourced from `DefinitionS3Location` (an S3 asset of the
same SDL file), with no resolver.

AppSync applies a schema asynchronously: `StartSchemaCreation` returns while
`GetSchemaCreationStatus` reads `PROCESSING`, and the API keeps serving the
previous schema until it reads `SUCCESS`. Before the fix cdkd did not wait, so
the observed baseline recorded the previous schema (`cdkd drift` reported an
untouched stack, and `cdkd drift --revert` pushed the old schema back, which
also deleted the resolver of the added field), and a schema AppSync refuses
(`FAILED`) deployed with exit 0.

`verify.sh` (`CDKD_TEST_SCHEMA` picks the SDL file under `lib/schemas/`):

1. Creates the API with `v1` (`Query.a`) and requires the observed baseline
   to hold it and `cdkd drift --json` to report the stack clean.
2. Deploys `v2`, which adds `Query.b` and a resolver on it, and requires the
   baseline to hold `Query.b`, the live SDL to have it, the resolver to exist
   and drift to be clean. Both APIs.
3. Writes the S3-sourced schema's `v1` baseline back into state, what a cdkd
   before #7127 recorded, and requires drift to stay clean: the heal reads the
   declared S3 object and finds the live SDL is its body (#7139).
4. Runs `cdkd drift --revert --yes` on the untouched stack and requires that
   nothing is reverted, the API is the same one (`revert-identity.sh`), and
   `Query.b` and its resolver are still live, on the S3-sourced API too.
5. Deploys `invalid` (`a: NoSuchType`) with `--verbose` and requires a
   non-zero exit naming `AWS AppSync reports FAILED` and AWS's own reason,
   then that the rollback left `v2` live with its resolver and drift clean.
   The S3-sourced schema stays on `v2` and keeps its seeded baseline.
6. Destroys the stack and checks that both APIs and state are gone.

Build the repository first. The maintainer runs this fixture via `/run-integ
appsync-schema-update-drift`, with `STATE_BUCKET` and `AWS_REGION` set. It
deploys real AWS resources and is not run as part of the local unit checks.
