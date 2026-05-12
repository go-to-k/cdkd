## [0.94.8](https://github.com/go-to-k/cdkd/compare/v0.94.7...v0.94.8) (2026-05-12)

## [0.94.7](https://github.com/go-to-k/cdkd/compare/v0.94.6...v0.94.7) (2026-05-12)


### Bug Fixes

* **export:** preserve phase-1 overlay in phase-2 UPDATE to prevent silent REPLACE ([#316](https://github.com/go-to-k/cdkd/issues/316)) ([40d9675](https://github.com/go-to-k/cdkd/commit/40d9675ff5098cff4e8008434bbc821464504c33))

## [0.94.6](https://github.com/go-to-k/cdkd/compare/v0.94.5...v0.94.6) (2026-05-12)


### Bug Fixes

* **export:** auto pre-delete + phase-2 CREATE for AWS::IAM::Policy ([#315](https://github.com/go-to-k/cdkd/issues/315)) ([88e76fd](https://github.com/go-to-k/cdkd/commit/88e76fd0caaf51d78f94f0597d1280ef8d2c140b))

## [0.94.5](https://github.com/go-to-k/cdkd/compare/v0.94.4...v0.94.5) (2026-05-12)


### Bug Fixes

* **export:** document dry-run permissiveness in CLAUDE.md (re-publish v0.94.4) ([#313](https://github.com/go-to-k/cdkd/issues/313)) ([c3d74bd](https://github.com/go-to-k/cdkd/commit/c3d74bd4487f81f827635df447561ccd1e16711e))

## [0.94.4](https://github.com/go-to-k/cdkd/compare/v0.94.3...v0.94.4) (2026-05-12)


### Bug Fixes

* **export:** make --dry-run permissive on missing --include-non-importable ([#311](https://github.com/go-to-k/cdkd/issues/311)) ([e5b61d4](https://github.com/go-to-k/cdkd/commit/e5b61d4a04ce35b0d173721b05e64b443fd8c9cd))

## [0.94.3](https://github.com/go-to-k/cdkd/compare/v0.94.2...v0.94.3) (2026-05-12)


### Bug Fixes

* **deploy:** prefix-migration check false-positive on auto-generated names ([#310](https://github.com/go-to-k/cdkd/issues/310)) ([07aeb74](https://github.com/go-to-k/cdkd/commit/07aeb74d5fc085e18033673094fa2fcb6eb9eec0))

## [0.94.2](https://github.com/go-to-k/cdkd/compare/v0.94.1...v0.94.2) (2026-05-12)


### Bug Fixes

* **export:** auto pre-delete + phase-2 CREATE for IMPORT-unsupported types (closes [#307](https://github.com/go-to-k/cdkd/issues/307)) ([#309](https://github.com/go-to-k/cdkd/issues/309)) ([25770f1](https://github.com/go-to-k/cdkd/commit/25770f17cc722bdc90e968477a9391a8ec2a0554))

## [0.94.1](https://github.com/go-to-k/cdkd/compare/v0.94.0...v0.94.1) (2026-05-12)


### Bug Fixes

* **export:** add composite-id splitters for ApiGwV2 Integration/Route + Lambda::Permission ([#308](https://github.com/go-to-k/cdkd/issues/308)) ([9384b7b](https://github.com/go-to-k/cdkd/commit/9384b7be19bb2babc8b1a694055980f99f523c7d))

# [0.94.0](https://github.com/go-to-k/cdkd/compare/v0.93.0...v0.94.0) (2026-05-12)

# [0.93.0](https://github.com/go-to-k/cdkd/compare/v0.92.0...v0.93.0) (2026-05-12)


### Features

* **deploy:** pre-flight warning when --no-prefix-user-supplied-names triggers REPLACEMENT ([#304](https://github.com/go-to-k/cdkd/issues/304)) ([2ce2815](https://github.com/go-to-k/cdkd/commit/2ce281501908ebeb3d7cee5507a3971b7f56621a))

# [0.92.0](https://github.com/go-to-k/cdkd/compare/v0.91.5...v0.92.0) (2026-05-12)


### Features

* **deploy:** opt-in --no-prefix-user-supplied-names flag ([#297](https://github.com/go-to-k/cdkd/issues/297)) ([e7d3da7](https://github.com/go-to-k/cdkd/commit/e7d3da71c454ea09712714f49c7009f3b9207ce8))

## [0.91.5](https://github.com/go-to-k/cdkd/compare/v0.91.4...v0.91.5) (2026-05-12)


### Bug Fixes

* **local:** bundle 3 follow-ups for cdkd local invoke/start-api/run-task (closes [#286](https://github.com/go-to-k/cdkd/issues/286) Gaps 3-6 + PR 294 deferred) ([#295](https://github.com/go-to-k/cdkd/issues/295)) ([2c5b819](https://github.com/go-to-k/cdkd/commit/2c5b819b539ee7311bf6702a9c8c592265964488))

## [0.91.4](https://github.com/go-to-k/cdkd/compare/v0.91.3...v0.91.4) (2026-05-12)


### Bug Fixes

* **export:** integ-catch 4 export bugs + cfn-response fixture + IMPORT diagnostics ([#285](https://github.com/go-to-k/cdkd/issues/285)) ([787e885](https://github.com/go-to-k/cdkd/commit/787e88507a1ff8ad63626edd513cc89095bbbcdd))

## [0.91.3](https://github.com/go-to-k/cdkd/compare/v0.91.2...v0.91.3) (2026-05-12)


### Bug Fixes

* **local:** cdkd local run-task --from-state substitutes intrinsic env vars + Secrets ValueFrom (closes [#291](https://github.com/go-to-k/cdkd/issues/291)) ([#294](https://github.com/go-to-k/cdkd/issues/294)) ([f36921a](https://github.com/go-to-k/cdkd/commit/f36921acde7233bb2f186836caff4294d13fd1c4))

## [0.91.2](https://github.com/go-to-k/cdkd/compare/v0.91.1...v0.91.2) (2026-05-11)


### Bug Fixes

* **local:** resolve Fn::Join Code.ImageUri for lambda.DockerImageCode.fromEcr (Gap 2 of [#286](https://github.com/go-to-k/cdkd/issues/286)) ([#293](https://github.com/go-to-k/cdkd/issues/293)) ([5e0af3c](https://github.com/go-to-k/cdkd/commit/5e0af3c71e8dfd5d385be0ba4d684e3d6a31fa44))

## [0.91.1](https://github.com/go-to-k/cdkd/compare/v0.91.0...v0.91.1) (2026-05-11)


### Bug Fixes

* **analyzer:** explicit Fn::Join / Fn::Select / Fn::Split descent in extractRefsFromValue (Gap 7 of [#286](https://github.com/go-to-k/cdkd/issues/286)) ([#292](https://github.com/go-to-k/cdkd/issues/292)) ([a8fd55f](https://github.com/go-to-k/cdkd/commit/a8fd55f8951ec31c31b483fdca8ed44be53e88e2))

# [0.91.0](https://github.com/go-to-k/cdkd/compare/v0.90.0...v0.91.0) (2026-05-11)


### Bug Fixes

* **local:** close PR [#267](https://github.com/go-to-k/cdkd/issues/267) minor latent items — topoSort / state-loader globalClients / test wording ([#269](https://github.com/go-to-k/cdkd/issues/269)) ([#289](https://github.com/go-to-k/cdkd/issues/289)) ([4f4c600](https://github.com/go-to-k/cdkd/commit/4f4c60081d9e7d4b64b2a1f8d10f1864946d647c))


### Features

* **hooks:** pr-review markgate gate enforces reviewer dispatch on size-flagged PRs ([#270](https://github.com/go-to-k/cdkd/issues/270)) ([#290](https://github.com/go-to-k/cdkd/issues/290)) ([58810c7](https://github.com/go-to-k/cdkd/commit/58810c7406e89f87da168e5b0d7bc44995d71770))

# [0.90.0](https://github.com/go-to-k/cdkd/compare/v0.89.0...v0.90.0) (2026-05-11)


### Bug Fixes

* **hooks:** branch-gate doesn't over-trigger on commit/push as literal word ([#281](https://github.com/go-to-k/cdkd/issues/281)) ([#287](https://github.com/go-to-k/cdkd/issues/287)) ([c18d717](https://github.com/go-to-k/cdkd/commit/c18d7172ba354e529ec8570b69c56f434041baa5))


### Features

* **hooks:** post-merge-orphan-push-gate blocks pushes to merged-PR's deleted branch ([#277](https://github.com/go-to-k/cdkd/issues/277)) ([#288](https://github.com/go-to-k/cdkd/issues/288)) ([0f8c2f6](https://github.com/go-to-k/cdkd/commit/0f8c2f62e32f3b73cf19a703672fd13c3236a2c6))

# [0.89.0](https://github.com/go-to-k/cdkd/compare/v0.88.0...v0.89.0) (2026-05-11)


### Features

* **cli:** cdkd export — cross-stack scan + drift baseline pre-flight (PR5) ([#284](https://github.com/go-to-k/cdkd/issues/284)) ([1442ab1](https://github.com/go-to-k/cdkd/commit/1442ab1e778e667ba3af1a1c2518e9f36a8dc285))

# [0.88.0](https://github.com/go-to-k/cdkd/compare/v0.87.0...v0.88.0) (2026-05-11)


### Features

* **cli:** cdkd export — template Parameters transfer (PR4) ([#283](https://github.com/go-to-k/cdkd/issues/283)) ([b400af1](https://github.com/go-to-k/cdkd/commit/b400af14475d5099a0892ef094eca2bcf1714f31))

# [0.87.0](https://github.com/go-to-k/cdkd/compare/v0.86.0...v0.87.0) (2026-05-11)


### Features

* **cli:** cdkd export — 2-phase IMPORT+UPDATE for Custom Resources (PR3) ([#282](https://github.com/go-to-k/cdkd/issues/282)) ([e090860](https://github.com/go-to-k/cdkd/commit/e09086061ccde459e737b4d718a00759baca4413))

# [0.86.0](https://github.com/go-to-k/cdkd/compare/v0.85.0...v0.86.0) (2026-05-11)


### Features

* **cli:** cdkd export — composite primary identifier support (PR2) ([#279](https://github.com/go-to-k/cdkd/issues/279)) ([fc38016](https://github.com/go-to-k/cdkd/commit/fc380162434a424bf0ed9c7e276ccd8cf5f86ae8))

# [0.85.0](https://github.com/go-to-k/cdkd/compare/v0.84.0...v0.85.0) (2026-05-11)


### Features

* **local-run-task:** resolve Fn::Join ECR image URIs from CDK 2.x fromEcrRepository ([#271](https://github.com/go-to-k/cdkd/issues/271)) ([#280](https://github.com/go-to-k/cdkd/issues/280)) ([3209319](https://github.com/go-to-k/cdkd/commit/3209319a13836952b637d88684f21b6fbb4ca8fd))

# [0.84.0](https://github.com/go-to-k/cdkd/compare/v0.83.1...v0.84.0) (2026-05-11)


### Features

* **cli:** cdkd export — hand cdkd-managed stack over to CloudFormation (MVP) ([#272](https://github.com/go-to-k/cdkd/issues/272)) ([ef29e46](https://github.com/go-to-k/cdkd/commit/ef29e469ac2146042d3684cc3867ae6d4b9de51f))

## [0.83.1](https://github.com/go-to-k/cdkd/compare/v0.83.0...v0.83.1) (2026-05-11)


### Bug Fixes

* **analyzer:** Fn::Sub 1-arg body produces no DAG edge to same-stack resource ([#275](https://github.com/go-to-k/cdkd/issues/275)) ([#276](https://github.com/go-to-k/cdkd/issues/276)) ([422c265](https://github.com/go-to-k/cdkd/commit/422c2658ab54efe5c05d839615d4fa051f77458c))

# [0.83.0](https://github.com/go-to-k/cdkd/compare/v0.82.1...v0.83.0) (2026-05-11)


### Features

* **local-run-task:** TaskRoleArn intrinsics + Fn::Sub resolution + orchestrator tests ([#267](https://github.com/go-to-k/cdkd/issues/267)) ([6e08f53](https://github.com/go-to-k/cdkd/commit/6e08f53e8b77e6148895447bce16f6b21a1cfe42))

## [0.82.1](https://github.com/go-to-k/cdkd/compare/v0.82.0...v0.82.1) (2026-05-11)


### Bug Fixes

* **cli:** single-flight cleanup for cdkd local invoke + cdkd local start-api ([#266](https://github.com/go-to-k/cdkd/issues/266)) ([5a429e7](https://github.com/go-to-k/cdkd/commit/5a429e7613a621f8205a3ed0ad19d7afd905fe7e))

# [0.82.0](https://github.com/go-to-k/cdkd/compare/v0.81.0...v0.82.0) (2026-05-11)


### Features

* **cli:** cdkd local run-task — Phase 1 of ECS local execution ([#262](https://github.com/go-to-k/cdkd/issues/262)) ([#263](https://github.com/go-to-k/cdkd/issues/263)) ([8b83991](https://github.com/go-to-k/cdkd/commit/8b839912de1f4724bbc40554565d5347e9e5cbef))

# [0.81.0](https://github.com/go-to-k/cdkd/compare/v0.80.0...v0.81.0) (2026-05-11)


### Features

* **cli:** cdkd local start-api one HTTP server per API + fixes (closes [#260](https://github.com/go-to-k/cdkd/issues/260)) ([#260](https://github.com/go-to-k/cdkd/issues/260)) ([2874459](https://github.com/go-to-k/cdkd/commit/2874459e073c0507b603996e5b7238a29b1fd263))

# [0.80.0](https://github.com/go-to-k/cdkd/compare/v0.79.0...v0.80.0) (2026-05-11)


### Features

* **cli:** cdkd local invoke / start-api provided.* runtimes + go1.x deprecation (closes [#248](https://github.com/go-to-k/cdkd/issues/248)) ([#258](https://github.com/go-to-k/cdkd/issues/258)) ([fc88974](https://github.com/go-to-k/cdkd/commit/fc88974268cb9d0748cf91394048c4e4db2a7158))

# [0.79.0](https://github.com/go-to-k/cdkd/compare/v0.78.0...v0.79.0) (2026-05-11)


### Features

* **cli:** cdkd local invoke / start-api .NET runtime support ([#257](https://github.com/go-to-k/cdkd/issues/257)) ([aa01e2e](https://github.com/go-to-k/cdkd/commit/aa01e2ed6ae9ac57992e00e2a21932deef65f3d6))

# [0.78.0](https://github.com/go-to-k/cdkd/compare/v0.77.0...v0.78.0) (2026-05-11)


### Features

* **cli:** cdkd local invoke / start-api Java runtime support ([#256](https://github.com/go-to-k/cdkd/issues/256)) ([29d560c](https://github.com/go-to-k/cdkd/commit/29d560c2f80d3fd23815af6a6f22e5c3f3271469))

# [0.77.0](https://github.com/go-to-k/cdkd/compare/v0.76.0...v0.77.0) (2026-05-11)


### Features

* **cli:** cdkd local invoke / start-api Ruby runtime support ([#254](https://github.com/go-to-k/cdkd/issues/254)) ([44a5c40](https://github.com/go-to-k/cdkd/commit/44a5c407ca21b63b7a3116374814d097ba4c130c))

# [0.76.0](https://github.com/go-to-k/cdkd/compare/v0.75.2...v0.76.0) (2026-05-10)


### Features

* **cli:** cdkd local invoke / start-api - Node.js 24 + Python 3.14 runtime support ([#249](https://github.com/go-to-k/cdkd/issues/249)) ([ef81af0](https://github.com/go-to-k/cdkd/commit/ef81af04a1ce2d61917036fa3703aff8c12f7375))

## [0.75.2](https://github.com/go-to-k/cdkd/compare/v0.75.1...v0.75.2) (2026-05-10)


### Bug Fixes

* **local:** authorizer IAM glob + Bearer regex + audience field polish (closes 3 items in [#241](https://github.com/go-to-k/cdkd/issues/241)) ([#246](https://github.com/go-to-k/cdkd/issues/246)) ([afb2466](https://github.com/go-to-k/cdkd/commit/afb2466d5a5d22f80fd388ef47386a7d3ef1648b))

## [0.75.1](https://github.com/go-to-k/cdkd/compare/v0.75.0...v0.75.1) (2026-05-10)


### Bug Fixes

* **local:** HTTP API v2 --stage override + Layer resolver string-form + cpSync mode-preservation comment (closes 3 items in 241) ([#245](https://github.com/go-to-k/cdkd/issues/245)) ([c40c0c9](https://github.com/go-to-k/cdkd/commit/c40c0c94778713ff226fc2fef7021551bef70194))

# [0.75.0](https://github.com/go-to-k/cdkd/compare/v0.74.0...v0.75.0) (2026-05-10)


### Features

* **cli:** cdkd local start-api — hot reload + CORS preflight + stage variables (closes [#235](https://github.com/go-to-k/cdkd/issues/235)) ([#238](https://github.com/go-to-k/cdkd/issues/238)) ([3bb6b7b](https://github.com/go-to-k/cdkd/commit/3bb6b7b86c9c38eaa90c964ce42cec0744ec80f9))

# [0.74.0](https://github.com/go-to-k/cdkd/compare/v0.73.0...v0.74.0) (2026-05-10)


### Features

* **cli:** cdkd local invoke -- Lambda Layers support (closes [#232](https://github.com/go-to-k/cdkd/issues/232)) ([#239](https://github.com/go-to-k/cdkd/issues/239)) ([8c570a8](https://github.com/go-to-k/cdkd/commit/8c570a8600326950b7592b5240589569d255fc1b))

# [0.73.0](https://github.com/go-to-k/cdkd/compare/v0.72.0...v0.73.0) (2026-05-10)


### Features

* **cli:** cdkd local start-api - authorizers + VPC simulation (closes [#234](https://github.com/go-to-k/cdkd/issues/234)) ([#237](https://github.com/go-to-k/cdkd/issues/237)) ([84ab835](https://github.com/go-to-k/cdkd/commit/84ab8357ba053072668877bb18693b9621445625))

# [0.72.0](https://github.com/go-to-k/cdkd/compare/v0.71.0...v0.72.0) (2026-05-10)


### Features

* **cli:** cdkd local invoke --no-build for container Lambdas (closes [#233](https://github.com/go-to-k/cdkd/issues/233)) ([#236](https://github.com/go-to-k/cdkd/issues/236)) ([70948f9](https://github.com/go-to-k/cdkd/commit/70948f90bbb9c4b41536fd51249effe3b1b577ea))

# [0.71.0](https://github.com/go-to-k/cdkd/compare/v0.70.0...v0.71.0) (2026-05-10)


### Features

* **cli:** cdkd local start-api (PR 8a of [#224](https://github.com/go-to-k/cdkd/issues/224)) ([#231](https://github.com/go-to-k/cdkd/issues/231)) ([afd5ebd](https://github.com/go-to-k/cdkd/commit/afd5ebde0d5aa999dc3213b3b638a27d89882ef2))

# [0.70.0](https://github.com/go-to-k/cdkd/compare/v0.69.0...v0.70.0) (2026-05-10)


### Features

* **cli:** cdkd local invoke container Lambda support (PR 5 of [#224](https://github.com/go-to-k/cdkd/issues/224)) ([#229](https://github.com/go-to-k/cdkd/issues/229)) ([47e73a7](https://github.com/go-to-k/cdkd/commit/47e73a7eea0f60b88e991f45c8cca2cddaf8a265))

# [0.69.0](https://github.com/go-to-k/cdkd/compare/v0.68.0...v0.69.0) (2026-05-10)


### Features

* **cli:** cdkd local invoke --from-state (PR 2 of [#224](https://github.com/go-to-k/cdkd/issues/224)) ([#227](https://github.com/go-to-k/cdkd/issues/227)) ([7b14b68](https://github.com/go-to-k/cdkd/commit/7b14b6851ab04b82debb9812064f5efe1e4d43c8))

# [0.68.0](https://github.com/go-to-k/cdkd/compare/v0.67.0...v0.68.0) (2026-05-10)


### Features

* **cli:** cdkd local invoke Python runtimes (PR 4 of [#224](https://github.com/go-to-k/cdkd/issues/224)) ([#226](https://github.com/go-to-k/cdkd/issues/226)) ([402d7fa](https://github.com/go-to-k/cdkd/commit/402d7faf33e2ec2d517909a45b377a4ccab31517))

# [0.67.0](https://github.com/go-to-k/cdkd/compare/v0.66.0...v0.67.0) (2026-05-10)


### Features

* **cli:** cdkd local invoke (PR 1 of [#224](https://github.com/go-to-k/cdkd/issues/224)) ([#225](https://github.com/go-to-k/cdkd/issues/225)) ([1d82d24](https://github.com/go-to-k/cdkd/commit/1d82d24a7cfbacb8dde27e45e02d27aa5b6a4791))

# [0.66.0](https://github.com/go-to-k/cdkd/compare/v0.65.0...v0.66.0) (2026-05-09)


### Features

* **hooks:** add provider-docs-gate.sh to block commits missing supported-resources.md / import.md entries ([#220](https://github.com/go-to-k/cdkd/issues/220)) ([512eebf](https://github.com/go-to-k/cdkd/commit/512eebfb8ff26550f556f84e1652baad16e60120))

# [0.65.0](https://github.com/go-to-k/cdkd/compare/v0.64.0...v0.65.0) (2026-05-09)


### Features

* **glue:** SDK providers for Job/Crawler/Connection/Trigger with drift coverage ([#214](https://github.com/go-to-k/cdkd/issues/214)) ([f8db936](https://github.com/go-to-k/cdkd/commit/f8db936888ecb6cfc86dc6b4fdd2473de4be5bc8))

# [0.64.0](https://github.com/go-to-k/cdkd/compare/v0.63.0...v0.64.0) (2026-05-09)


### Features

* **glue:** SDK providers for Workflow/SecurityConfiguration with drift coverage ([#213](https://github.com/go-to-k/cdkd/issues/213)) ([cad7d9d](https://github.com/go-to-k/cdkd/commit/cad7d9dd54ef6817334305278ca68085d3069035))

# [0.63.0](https://github.com/go-to-k/cdkd/compare/v0.62.0...v0.63.0) (2026-05-09)


### Features

* **kinesis,ec2:** Kinesis StreamConsumer SDK provider + EC2 sub-resource Tags coverage ([#212](https://github.com/go-to-k/cdkd/issues/212)) ([5906d67](https://github.com/go-to-k/cdkd/commit/5906d676e369fa7f70d0079e27303bde47e6f463))

# [0.62.0](https://github.com/go-to-k/cdkd/compare/v0.61.0...v0.62.0) (2026-05-09)


### Features

* **s3:** cover 12 sub-configs in readCurrentState + update ([#215](https://github.com/go-to-k/cdkd/issues/215)) ([18e225f](https://github.com/go-to-k/cdkd/commit/18e225fe1c4797d5459542352781f59564801fb4))

# [0.61.0](https://github.com/go-to-k/cdkd/compare/v0.60.2...v0.61.0) (2026-05-09)


### Features

* **appsync:** canonicalize GraphQL Schema.Definition for drift detection ([#210](https://github.com/go-to-k/cdkd/issues/210)) ([a8e354c](https://github.com/go-to-k/cdkd/commit/a8e354cce0c4dfdfa4ccc0c0b0d6eb3d6b832fb3))
* **asg:** surface 4 complex sub-shapes in readCurrentState + update ([#211](https://github.com/go-to-k/cdkd/issues/211)) ([a911972](https://github.com/go-to-k/cdkd/commit/a911972d450674aa73be73353df72b3c95b5feed))

## [0.60.2](https://github.com/go-to-k/cdkd/compare/v0.60.1...v0.60.2) (2026-05-09)


### Bug Fixes

* **ec2:** extend DependencyViolation retry budget for IGW + VPCGw to 10 min ([#209](https://github.com/go-to-k/cdkd/issues/209)) ([890343e](https://github.com/go-to-k/cdkd/commit/890343e4341b13c5297875c5a0bbd40dcd95b60d))

## [0.60.1](https://github.com/go-to-k/cdkd/compare/v0.60.0...v0.60.1) (2026-05-09)


### Bug Fixes

* **cli:** auto-lower --resource-warn-after when --resource-timeout is set below 5m default ([#208](https://github.com/go-to-k/cdkd/issues/208)) ([55773a5](https://github.com/go-to-k/cdkd/commit/55773a50587ae8b14e6727fc0ebb73ce61970c9e))

# [0.60.0](https://github.com/go-to-k/cdkd/compare/v0.59.1...v0.60.0) (2026-05-09)


### Features

* **providers:** SDK providers for DocDB and Neptune (with --remove-protection support) ([#207](https://github.com/go-to-k/cdkd/issues/207)) ([86d42c8](https://github.com/go-to-k/cdkd/commit/86d42c893f0f6bd52dbfb3d5ad559951b9c42573))

## [0.59.1](https://github.com/go-to-k/cdkd/compare/v0.59.0...v0.59.1) (2026-05-09)


### Bug Fixes

* **intrinsic:** resolve LaunchTemplate.LatestVersionNumber + add real-AWS integ for --remove-protection ([#206](https://github.com/go-to-k/cdkd/issues/206)) ([840ae3d](https://github.com/go-to-k/cdkd/commit/840ae3dd9fb532725dafb067a7aa908f7cad30b0))

# [0.59.0](https://github.com/go-to-k/cdkd/compare/v0.58.0...v0.59.0) (2026-05-09)

# [0.58.0](https://github.com/go-to-k/cdkd/compare/v0.57.1...v0.58.0) (2026-05-09)


### Features

* **destroy:** honor stack-level terminationProtection in cdkd destroy ([#204](https://github.com/go-to-k/cdkd/issues/204)) ([502bcd0](https://github.com/go-to-k/cdkd/commit/502bcd0c48fb1b0874638fff7651b4c016eaa598))

## [0.57.1](https://github.com/go-to-k/cdkd/compare/v0.57.0...v0.57.1) (2026-05-09)


### Bug Fixes

* **sns:** normalize DeliveryStatusLogging Protocol case before building AWS attribute names ([#203](https://github.com/go-to-k/cdkd/issues/203)) ([767c3c3](https://github.com/go-to-k/cdkd/commit/767c3c3ac71cfc72a543737fd6ad5e387394f1fd))

# [0.57.0](https://github.com/go-to-k/cdkd/compare/v0.56.0...v0.57.0) (2026-05-09)


### Features

* **elbv2:** in-place update for LoadBalancer Subnets/SGs/IpAddressType + Listener AlpnPolicy/MutualAuthentication ([#199](https://github.com/go-to-k/cdkd/issues/199)) ([57aa9c9](https://github.com/go-to-k/cdkd/commit/57aa9c9ddf6f2524b45e7f03597af83ec180a3a5))

# [0.56.0](https://github.com/go-to-k/cdkd/compare/v0.55.0...v0.56.0) (2026-05-09)


### Features

* **apigatewayv2:** in-place update for all 5 supported AWS::ApiGatewayV2::* types ([#198](https://github.com/go-to-k/cdkd/issues/198)) ([a1579f0](https://github.com/go-to-k/cdkd/commit/a1579f0c3a5fd2b7015c306a5e92e0666b272fdf))

# [0.55.0](https://github.com/go-to-k/cdkd/compare/v0.54.0...v0.55.0) (2026-05-09)


### Features

* **ecs:** in-place update for AWS::ECS::Cluster ClusterSettings + Configuration ([#197](https://github.com/go-to-k/cdkd/issues/197)) ([d9034d4](https://github.com/go-to-k/cdkd/commit/d9034d4cc82e2fd7a2ac55ee021e2b08fa4895a1))

# [0.54.0](https://github.com/go-to-k/cdkd/compare/v0.53.0...v0.54.0) (2026-05-09)


### Features

* **apigateway:** in-place update for Authorizer + Method via RFC 6902 PATCH ops ([#196](https://github.com/go-to-k/cdkd/issues/196)) ([40df3e6](https://github.com/go-to-k/cdkd/commit/40df3e6ffa13cf80a85cce6cac0341977c3e839c))

# [0.53.0](https://github.com/go-to-k/cdkd/compare/v0.52.0...v0.53.0) (2026-05-09)


### Features

* **provider:** in-place update for Glue Database / ServiceDiscovery namespace+service / EFS FileSystem+MountTarget ([#195](https://github.com/go-to-k/cdkd/issues/195)) ([e91c991](https://github.com/go-to-k/cdkd/commit/e91c99167523cb299867a4bcde739fcf404f7c88))

# [0.52.0](https://github.com/go-to-k/cdkd/compare/v0.51.10...v0.52.0) (2026-05-08)


### Features

* **logs:** apply DeletionProtectionEnabled / BearerTokenAuthenticationEnabled / FieldIndexPolicies on create + update ([#194](https://github.com/go-to-k/cdkd/issues/194)) ([52e7e6d](https://github.com/go-to-k/cdkd/commit/52e7e6dc852417378410c381813bb452bc306197))

## [0.51.10](https://github.com/go-to-k/cdkd/compare/v0.51.9...v0.51.10) (2026-05-08)


### Bug Fixes

* **drift:** reverse-map SNS Topic DeliveryStatusLogging from per-protocol attributes ([#192](https://github.com/go-to-k/cdkd/issues/192)) ([8612775](https://github.com/go-to-k/cdkd/commit/86127755bc0c8dd81b9985e0433eec03a38f1d08))

## [0.51.9](https://github.com/go-to-k/cdkd/compare/v0.51.8...v0.51.9) (2026-05-08)


### Bug Fixes

* **drift:** close final reverse-mappable edge cases (Firehose encryption + EC2 Instance DisableApiTermination) ([#191](https://github.com/go-to-k/cdkd/issues/191)) ([c5834ce](https://github.com/go-to-k/cdkd/commit/c5834cee845f93b9886a6df5fd438a5527a128cb))

## [0.51.8](https://github.com/go-to-k/cdkd/compare/v0.51.7...v0.51.8) (2026-05-08)


### Bug Fixes

* **drift:** reverse-map Firehose non-S3 destinations ([#181](https://github.com/go-to-k/cdkd/issues/181) final close) ([#190](https://github.com/go-to-k/cdkd/issues/190)) ([de7e12f](https://github.com/go-to-k/cdkd/commit/de7e12feae74986f5db69db4b06ff0055a4e9a03))

## [0.51.7](https://github.com/go-to-k/cdkd/compare/v0.51.6...v0.51.7) (2026-05-08)


### Bug Fixes

* **drift:** reverse-map Firehose S3/ExtendedS3 inner nested fields ([#181](https://github.com/go-to-k/cdkd/issues/181) follow-up) ([#189](https://github.com/go-to-k/cdkd/issues/189)) ([0b2a7f4](https://github.com/go-to-k/cdkd/commit/0b2a7f4ed0311e2f960996377b7eaaed3dc33ca4))

## [0.51.6](https://github.com/go-to-k/cdkd/compare/v0.51.5...v0.51.6) (2026-05-08)


### Bug Fixes

* **drift:** cover 6 EC2 sub-resource types via parent-list extraction ([#182](https://github.com/go-to-k/cdkd/issues/182) final close) ([#188](https://github.com/go-to-k/cdkd/issues/188)) ([48600cf](https://github.com/go-to-k/cdkd/commit/48600cf1e972e9242dbcf5365f17eb49d1150983))

## [0.51.5](https://github.com/go-to-k/cdkd/compare/v0.51.4...v0.51.5) (2026-05-08)


### Bug Fixes

* **drift:** expand EC2::Instance drift coverage ([#182](https://github.com/go-to-k/cdkd/issues/182) partial close, instance-level) ([#187](https://github.com/go-to-k/cdkd/issues/187)) ([e8cab95](https://github.com/go-to-k/cdkd/commit/e8cab95c38b51f36918d0dbe26beb8638709833f))

## [0.51.4](https://github.com/go-to-k/cdkd/compare/v0.51.3...v0.51.4) (2026-05-08)


### Bug Fixes

* **drift:** reverse-map EC2 SecurityGroup ingress/egress rules ([#182](https://github.com/go-to-k/cdkd/issues/182) partial close) ([#186](https://github.com/go-to-k/cdkd/issues/186)) ([09edfdf](https://github.com/go-to-k/cdkd/commit/09edfdfa4794215b08ab8883ef8401149f381693))

## [0.51.3](https://github.com/go-to-k/cdkd/compare/v0.51.2...v0.51.3) (2026-05-08)


### Bug Fixes

* **drift:** surface Firehose S3/ExtendedS3 destination subset ([#181](https://github.com/go-to-k/cdkd/issues/181) partial close) ([#185](https://github.com/go-to-k/cdkd/issues/185)) ([a8739d3](https://github.com/go-to-k/cdkd/commit/a8739d31659f0a4f52a7a5cf5ea507302ce60530))

## [0.51.2](https://github.com/go-to-k/cdkd/compare/v0.51.1...v0.51.2) (2026-05-08)


### Bug Fixes

* **drift:** close 5 tractable Cat C drift coverage gaps ([#176](https://github.com/go-to-k/cdkd/issues/176)-[#180](https://github.com/go-to-k/cdkd/issues/180)) ([#184](https://github.com/go-to-k/cdkd/issues/184)) ([685e898](https://github.com/go-to-k/cdkd/commit/685e898d19e2231375f1b9c7cb758801f9ff4938))

## [0.51.1](https://github.com/go-to-k/cdkd/compare/v0.51.0...v0.51.1) (2026-05-08)


### Bug Fixes

* **drift:** lift v1-punt drift coverage on 8 SDK providers ([#175](https://github.com/go-to-k/cdkd/issues/175)) ([6c01ca1](https://github.com/go-to-k/cdkd/commit/6c01ca1da35da15789784cf19d166893a418e4d5))

# [0.51.0](https://github.com/go-to-k/cdkd/compare/v0.50.13...v0.51.0) (2026-05-07)


### Features

* **deploy:** auto-refresh observed-properties on v2 state load ([#170](https://github.com/go-to-k/cdkd/issues/170)) ([51d2ef2](https://github.com/go-to-k/cdkd/commit/51d2ef26cd5b47f3375b429369d845d37772c930))

## [0.50.13](https://github.com/go-to-k/cdkd/compare/v0.50.12...v0.50.13) (2026-05-07)


### Bug Fixes

* **drift:** S3 Bucket Tags always-emit + audit closure for missed providers (PR 6) ([#168](https://github.com/go-to-k/cdkd/issues/168)) ([9eb5a4b](https://github.com/go-to-k/cdkd/commit/9eb5a4ba0b01f2f4795ae2e555116768d8432c42))

## [0.50.12](https://github.com/go-to-k/cdkd/compare/v0.50.11...v0.50.12) (2026-05-07)


### Bug Fixes

* **drift:** round-trip audit for tail providers (PR 5/5 — final) ([#167](https://github.com/go-to-k/cdkd/issues/167)) ([ac21101](https://github.com/go-to-k/cdkd/commit/ac21101e0876e84f738043eb649a878b4aad80b8))

## [0.50.11](https://github.com/go-to-k/cdkd/compare/v0.50.10...v0.50.11) (2026-05-07)


### Bug Fixes

* **drift:** round-trip audit for compute/API providers (PR 4/5) ([#166](https://github.com/go-to-k/cdkd/issues/166)) ([8e43e7e](https://github.com/go-to-k/cdkd/commit/8e43e7ebb6baadc238e4bda3e6320af8a0b8d8a8))

## [0.50.10](https://github.com/go-to-k/cdkd/compare/v0.50.9...v0.50.10) (2026-05-07)


### Bug Fixes

* **drift:** round-trip audit for network providers (PR 3/5) ([#165](https://github.com/go-to-k/cdkd/issues/165)) ([37a42f9](https://github.com/go-to-k/cdkd/commit/37a42f988bf81ed2e5e47645eaca074d2d9ca045))

## [0.50.9](https://github.com/go-to-k/cdkd/compare/v0.50.8...v0.50.9) (2026-05-07)


### Bug Fixes

* **drift:** round-trip audit for data-layer providers (PR 2/5) ([#164](https://github.com/go-to-k/cdkd/issues/164)) ([8e1fbe3](https://github.com/go-to-k/cdkd/commit/8e1fbe348f596a01df5cd332307a44cb1f9e472b))

## [0.50.8](https://github.com/go-to-k/cdkd/compare/v0.50.7...v0.50.8) (2026-05-07)


### Bug Fixes

* **drift:** round-trip audit for Lambda providers (PR 1/5) ([#163](https://github.com/go-to-k/cdkd/issues/163)) ([08e5e7d](https://github.com/go-to-k/cdkd/commit/08e5e7d0c43ecf12a8a034dfd088387b47968502))

## [0.50.7](https://github.com/go-to-k/cdkd/compare/v0.50.6...v0.50.7) (2026-05-07)


### Bug Fixes

* **drift:** --revert no longer rejects on placeholder values + IAM Role empty Description clear ([#161](https://github.com/go-to-k/cdkd/issues/161)) ([b1bbe74](https://github.com/go-to-k/cdkd/commit/b1bbe743b27c774dfb087bd59528f5b977d677dc))

## [0.50.6](https://github.com/go-to-k/cdkd/compare/v0.50.5...v0.50.6) (2026-05-07)


### Bug Fixes

* **drift:** apply Tags diff in update path + Lambda VpcConfig.Ipv6AllowedForDualStack always-emit ([#159](https://github.com/go-to-k/cdkd/issues/159)) ([4dde069](https://github.com/go-to-k/cdkd/commit/4dde069fd10f488fa3dcd8b0f2c3d755006e7e66))

## [0.50.5](https://github.com/go-to-k/cdkd/compare/v0.50.4...v0.50.5) (2026-05-07)


### Bug Fixes

* **drift:** guard FIFO-only SQS / SNS attributes from always-emit-placeholder ([#157](https://github.com/go-to-k/cdkd/issues/157)) ([22112be](https://github.com/go-to-k/cdkd/commit/22112be60855d6218534200e75bcc45a34f8315c))

## [0.50.4](https://github.com/go-to-k/cdkd/compare/v0.50.3...v0.50.4) (2026-05-07)


### Bug Fixes

* **drift:** always emit user-controllable top-level keys in Cognito UserPool readCurrentState (Phase 2c) ([#155](https://github.com/go-to-k/cdkd/issues/155)) ([6d55445](https://github.com/go-to-k/cdkd/commit/6d55445ea4692668f1cad1bf08404286fe7b1e1c))

## [0.50.3](https://github.com/go-to-k/cdkd/compare/v0.50.2...v0.50.3) (2026-05-07)


### Bug Fixes

* **drift:** always emit user-controllable top-level keys in AppSync + ApiGateway + ApiGatewayV2 readCurrentState (Phase 2b) ([#154](https://github.com/go-to-k/cdkd/issues/154)) ([8062785](https://github.com/go-to-k/cdkd/commit/80627850fe8301b22973d99516061710148468ed))

## [0.50.2](https://github.com/go-to-k/cdkd/compare/v0.50.1...v0.50.2) (2026-05-07)


### Bug Fixes

* **drift:** always emit user-controllable top-level keys in CloudWatch Alarm + CodeBuild readCurrentState (Phase 2a) ([#153](https://github.com/go-to-k/cdkd/issues/153)) ([e741b66](https://github.com/go-to-k/cdkd/commit/e741b66da177c7f11585d176632e77f449cc6050))

## [0.50.1](https://github.com/go-to-k/cdkd/compare/v0.50.0...v0.50.1) (2026-05-07)


### Bug Fixes

* **drift:** always emit user-controllable top-level keys in readCurrentState (Phase 1) ([#152](https://github.com/go-to-k/cdkd/issues/152)) ([8cc79e8](https://github.com/go-to-k/cdkd/commit/8cc79e8a29a45d30846d1cd092559abefa23805a))

# [0.50.0](https://github.com/go-to-k/cdkd/compare/v0.49.0...v0.50.0) (2026-05-07)


### Features

* **drift:** union-walk inside map-shaped properties on the observed-baseline path ([#147](https://github.com/go-to-k/cdkd/issues/147)) ([aaec509](https://github.com/go-to-k/cdkd/commit/aaec5093140aa7b31160dd2b5e2b980be24c5b14))

# [0.49.0](https://github.com/go-to-k/cdkd/compare/v0.48.0...v0.49.0) (2026-05-07)


### Features

* **state:** add cdkd state refresh-observed + fix Custom::* drift crash ([#146](https://github.com/go-to-k/cdkd/issues/146)) ([7e7624c](https://github.com/go-to-k/cdkd/commit/7e7624c294fc6ed3757ce485963492378f273df6))

# [0.48.0](https://github.com/go-to-k/cdkd/compare/v0.47.0...v0.48.0) (2026-05-07)


### Features

* **drift:** always emit Tags in readCurrentState to detect console-side adds on initially-untagged resources ([#145](https://github.com/go-to-k/cdkd/issues/145)) ([39c73df](https://github.com/go-to-k/cdkd/commit/39c73dfcb5d60e5b088b3fb19c6a4e306cdf22aa))

# [0.47.0](https://github.com/go-to-k/cdkd/compare/v0.46.1...v0.47.0) (2026-05-07)


### Features

* **drift:** observedProperties baseline (state schema v3) for richer drift detection ([#144](https://github.com/go-to-k/cdkd/issues/144)) ([338c15c](https://github.com/go-to-k/cdkd/commit/338c15c683bc4cfc1597ad472cfd36073fe5e61d))

## [0.46.1](https://github.com/go-to-k/cdkd/compare/v0.46.0...v0.46.1) (2026-05-06)


### Bug Fixes

* **drift:** single-stack auto-detect + getDriftUnknownPaths to suppress unreadable-state-key false drift ([#143](https://github.com/go-to-k/cdkd/issues/143)) ([88bd0bd](https://github.com/go-to-k/cdkd/commit/88bd0bdfcb99595c31d6bc3897947200834f8a9f))

# [0.46.0](https://github.com/go-to-k/cdkd/compare/v0.45.0...v0.46.0) (2026-05-06)


### Features

* **drift:** Tags coverage across SDK Providers + aws:* filter ([#142](https://github.com/go-to-k/cdkd/issues/142)) ([bb6c5c8](https://github.com/go-to-k/cdkd/commit/bb6c5c8f32691a40375dbd90f9551be536d32518))

# [0.45.0](https://github.com/go-to-k/cdkd/compare/v0.44.0...v0.45.0) (2026-05-06)


### Features

* **drift:** --revert provider.update audit + ResourceUpdateNotSupportedError ([#141](https://github.com/go-to-k/cdkd/issues/141)) ([975bd7b](https://github.com/go-to-k/cdkd/commit/975bd7bbc3a0e3cf93170422cd0cbc5b678fa49c))

# [0.44.0](https://github.com/go-to-k/cdkd/compare/v0.43.0...v0.44.0) (2026-05-06)


### Features

* **drift:** false-drift prevention for CC API fallback (deny-list + strip) ([#140](https://github.com/go-to-k/cdkd/issues/140)) ([6828d36](https://github.com/go-to-k/cdkd/commit/6828d36ca81bcbf41b33ca173a00f8ce22f50bd5))

# [0.43.0](https://github.com/go-to-k/cdkd/compare/v0.42.0...v0.43.0) (2026-05-05)


### Features

* **drift:** readCurrentState(properties) signature ext + close 4 sub-resource skips ([#139](https://github.com/go-to-k/cdkd/issues/139)) ([304aea2](https://github.com/go-to-k/cdkd/commit/304aea28b54aa9576da561280075d99ae5e6e199))

# [0.42.0](https://github.com/go-to-k/cdkd/compare/v0.41.0...v0.42.0) (2026-05-05)


### Features

* **drift:** CC API fallback when SDK Provider has no readCurrentState ([#138](https://github.com/go-to-k/cdkd/issues/138)) ([4a40903](https://github.com/go-to-k/cdkd/commit/4a4090333396027b3c23bb71acbe4a870f219d15))

# [0.41.0](https://github.com/go-to-k/cdkd/compare/v0.40.0...v0.41.0) (2026-05-05)


### Features

* **providers:** add readCurrentState to 12 SDK Providers (drift batch 3, final) ([#137](https://github.com/go-to-k/cdkd/issues/137)) ([f0aff76](https://github.com/go-to-k/cdkd/commit/f0aff765e229cfe1448eaed79e9e4c1415a10ee9))

# [0.40.0](https://github.com/go-to-k/cdkd/compare/v0.39.0...v0.40.0) (2026-05-05)


### Features

* **providers:** add readCurrentState to 14 SDK Providers (drift batch 2) ([#136](https://github.com/go-to-k/cdkd/issues/136)) ([9949f80](https://github.com/go-to-k/cdkd/commit/9949f80d8ecc44f618ead2366c404a26ea214748))

# [0.39.0](https://github.com/go-to-k/cdkd/compare/v0.38.0...v0.39.0) (2026-05-05)


### Features

* **providers:** add readCurrentState to 13 SDK Providers (drift batch 1) ([#135](https://github.com/go-to-k/cdkd/issues/135)) ([e9f017f](https://github.com/go-to-k/cdkd/commit/e9f017f98ff81c9a9d387e9de70428e3b2f86bab))

# [0.38.0](https://github.com/go-to-k/cdkd/compare/v0.37.0...v0.38.0) (2026-05-05)


### Features

* **cli:** cdkd drift --accept (state ← AWS) / --revert (AWS ← state) ([#134](https://github.com/go-to-k/cdkd/issues/134)) ([c99407b](https://github.com/go-to-k/cdkd/commit/c99407bed6b39db33405d683578aff0aefa36922))

# [0.37.0](https://github.com/go-to-k/cdkd/compare/v0.36.0...v0.37.0) (2026-05-05)


### Features

* **providers:** add readCurrentState to 7 SDK Providers (drift coverage) ([#133](https://github.com/go-to-k/cdkd/issues/133)) ([2902c94](https://github.com/go-to-k/cdkd/commit/2902c94421506601c15052d9f217033edc283034))

# [0.36.0](https://github.com/go-to-k/cdkd/compare/v0.35.0...v0.36.0) (2026-05-05)


### Features

* **cli:** publish-assets — synth + build + publish (no deploy); drop --path ([#131](https://github.com/go-to-k/cdkd/issues/131)) ([a856ac9](https://github.com/go-to-k/cdkd/commit/a856ac95b4bb3d78adcde1355e0e7cafbab8ef8a))

# [0.35.0](https://github.com/go-to-k/cdkd/compare/v0.34.0...v0.35.0) (2026-05-05)


### Features

* **cli:** add cdkd drift command (state vs AWS comparison, detection only) ([#130](https://github.com/go-to-k/cdkd/issues/130)) ([43fc7ff](https://github.com/go-to-k/cdkd/commit/43fc7ff226c0ed2094c79c51d2baef821915976e))

# [0.34.0](https://github.com/go-to-k/cdkd/compare/v0.33.0...v0.34.0) (2026-05-05)


### Features

* **cli:** add --role-arn (env: CDKD_ROLE_ARN) for assuming an IAM role ([#129](https://github.com/go-to-k/cdkd/issues/129)) ([371e351](https://github.com/go-to-k/cdkd/commit/371e351219d80b2e44ecf5535e1c49823db8f095))

# [0.33.0](https://github.com/go-to-k/cdkd/compare/v0.32.0...v0.33.0) (2026-05-04)

# [0.32.0](https://github.com/go-to-k/cdkd/compare/v0.31.2...v0.32.0) (2026-05-04)


### Features

* **deploy:** --aggressive-vpc-parallel relaxes CDK VPC route DependsOn (-54.6% on bench-cdk-sample) ([#126](https://github.com/go-to-k/cdkd/issues/126)) ([b3448ea](https://github.com/go-to-k/cdkd/commit/b3448ea57e7a3605e5f700e338f97426b12e5e08))

## [0.31.2](https://github.com/go-to-k/cdkd/compare/v0.31.1...v0.31.2) (2026-05-04)


### Bug Fixes

* **lambda:** derive inline ZipFile filename extension from runtime ([#125](https://github.com/go-to-k/cdkd/issues/125)) ([fed7150](https://github.com/go-to-k/cdkd/commit/fed7150b882f55c08a40a86824c93eef5eabf22d))

## [0.31.1](https://github.com/go-to-k/cdkd/compare/v0.31.0...v0.31.1) (2026-05-04)


### Bug Fixes

* **cli:** destroy exits with code 2 on partial failure (was silently exiting 0) ([#124](https://github.com/go-to-k/cdkd/issues/124)) ([a279a1b](https://github.com/go-to-k/cdkd/commit/a279a1be9a2f872f8050ddc56da9f10208c88e93))

# [0.31.0](https://github.com/go-to-k/cdkd/compare/v0.30.2...v0.31.0) (2026-05-04)


### Features

* **ec2:** add AWS::EC2::NatGateway SDK provider with deploy --no-wait support ([#123](https://github.com/go-to-k/cdkd/issues/123)) ([9f8d360](https://github.com/go-to-k/cdkd/commit/9f8d360b840080ebc01aa9b871e21d440686b13e))

## [0.30.2](https://github.com/go-to-k/cdkd/compare/v0.30.1...v0.30.2) (2026-05-03)


### Bug Fixes

* **lambda:** move post-CreateFunction wait to Custom Resource Invoke (was doubling deploy time) ([#122](https://github.com/go-to-k/cdkd/issues/122)) ([4a7fb38](https://github.com/go-to-k/cdkd/commit/4a7fb38b0f7ea1da9565721d8367733202d338dc))

## [0.30.1](https://github.com/go-to-k/cdkd/compare/v0.30.0...v0.30.1) (2026-05-03)


### Bug Fixes

* **lambda:** wait for State=Active after CreateFunction (Custom Resource race) ([#121](https://github.com/go-to-k/cdkd/issues/121)) ([553c623](https://github.com/go-to-k/cdkd/commit/553c6237892126c26b07ad2ddbe807f39fe38284))

# [0.30.0](https://github.com/go-to-k/cdkd/compare/v0.29.0...v0.30.0) (2026-05-03)


### Features

* **import:** support >51,200-byte templates in --migrate-from-cloudformation via TemplateURL ([#113](https://github.com/go-to-k/cdkd/issues/113)) ([26d6762](https://github.com/go-to-k/cdkd/commit/26d676288017fdde5c766d0081ad69e1f1e0ae4b))

# [0.29.0](https://github.com/go-to-k/cdkd/compare/v0.28.2...v0.29.0) (2026-05-03)


### Features

* **import:** add --migrate-from-cloudformation for one-shot CFn-to-cdkd migration ([#110](https://github.com/go-to-k/cdkd/issues/110)) ([ccd54f4](https://github.com/go-to-k/cdkd/commit/ccd54f4ee3a4d09947ca92182342ca9effb01ae5))
* **intrinsic:** add Fn::GetStackOutput for cross-stack/cross-region refs ([#111](https://github.com/go-to-k/cdkd/issues/111)) ([cd245b0](https://github.com/go-to-k/cdkd/commit/cd245b0e2647e68dc2a091ecff0c7d5462851766))

## [0.28.2](https://github.com/go-to-k/cdkd/compare/v0.28.1...v0.28.2) (2026-05-03)


### Bug Fixes

* **orphan:** match L2 construct paths and exclude CDKMetadata ([#109](https://github.com/go-to-k/cdkd/issues/109)) ([0846f64](https://github.com/go-to-k/cdkd/commit/0846f6437f960d8d67b475af94e2b6aaf11a6720))

## [0.28.1](https://github.com/go-to-k/cdkd/compare/v0.28.0...v0.28.1) (2026-05-03)


### Bug Fixes

* **import:** preserve unlisted state on selective import + soften --force ([#108](https://github.com/go-to-k/cdkd/issues/108)) ([2920ea7](https://github.com/go-to-k/cdkd/commit/2920ea715ab3920ff7a27e3dba6972074930f927))

# [0.28.0](https://github.com/go-to-k/cdkd/compare/v0.27.0...v0.28.0) (2026-05-03)


### Features

* **deploy,custom-resource:** close outer-retry hole + CR self-report timeout ([#104](https://github.com/go-to-k/cdkd/issues/104)) ([32fb5db](https://github.com/go-to-k/cdkd/commit/32fb5dbca8a2afb4ab081d587562ecbf04f3003f))

# [0.27.0](https://github.com/go-to-k/cdkd/compare/v0.26.0...v0.27.0) (2026-05-03)


### Features

* **providers:** close the 3 deferred getAttribute gaps ([#106](https://github.com/go-to-k/cdkd/issues/106)) ([b12009d](https://github.com/go-to-k/cdkd/commit/b12009d6eb14d58390a1e828ff49408ffb300ace))

# [0.26.0](https://github.com/go-to-k/cdkd/compare/v0.25.0...v0.26.0) (2026-05-02)


### Features

* **deploy,destroy:** per-resource-type timeout override ([#91](https://github.com/go-to-k/cdkd/issues/91) v2) ([#101](https://github.com/go-to-k/cdkd/issues/101)) ([9d342ac](https://github.com/go-to-k/cdkd/commit/9d342ac380f50d59c71b3a8cd6edd5f56eb3bcbb))
* **import:** add --record-resource-mapping <file> for cdk import parity ([#102](https://github.com/go-to-k/cdkd/issues/102)) ([31652c8](https://github.com/go-to-k/cdkd/commit/31652c82521ba7a1118ae5b1d5170f3ffc900bc9))

# [0.25.0](https://github.com/go-to-k/cdkd/compare/v0.24.0...v0.25.0) (2026-05-02)


### Features

* **deploy,destroy:** per-resource timeout (warn at 5m, abort at 30m) ([#99](https://github.com/go-to-k/cdkd/issues/99)) ([71d2cb9](https://github.com/go-to-k/cdkd/commit/71d2cb9a5af013da36ac8c9cd15b26b62ff4bf22))

# [0.24.0](https://github.com/go-to-k/cdkd/compare/v0.23.2...v0.24.0) (2026-05-02)


### Features

* **import:** add --resource-mapping-inline '<json>' for cdk import parity ([#97](https://github.com/go-to-k/cdkd/issues/97)) ([322776c](https://github.com/go-to-k/cdkd/commit/322776c71fb15667553cecb6d6810c352d560bb7))

## [0.23.2](https://github.com/go-to-k/cdkd/compare/v0.23.1...v0.23.2) (2026-05-02)


### Bug Fixes

* **custom-resource:** use same S3 key for ResponseURL signing and polling ([#94](https://github.com/go-to-k/cdkd/issues/94)) ([2c1ab7e](https://github.com/go-to-k/cdkd/commit/2c1ab7ea6f27fc30e898ee3a7bb44755e707626c))

## [0.23.1](https://github.com/go-to-k/cdkd/compare/v0.23.0...v0.23.1) (2026-05-02)


### Bug Fixes

* **cli:** point multi-region errors at --stack-region (not --region) ([#84](https://github.com/go-to-k/cdkd/issues/84)) ([4414b2b](https://github.com/go-to-k/cdkd/commit/4414b2be3d712072d81c38ece2d05978457ec8ff))

# [0.23.0](https://github.com/go-to-k/cdkd/compare/v0.22.0...v0.23.0) (2026-05-02)


### Features

* **import:** selective-resource semantics for CDK CLI parity + README guide ([#78](https://github.com/go-to-k/cdkd/issues/78)) ([d537c3d](https://github.com/go-to-k/cdkd/commit/d537c3d3e3da708e775ab9510e92d7a6ee0a1506))

# [0.22.0](https://github.com/go-to-k/cdkd/compare/v0.21.0...v0.22.0) (2026-05-02)


### Features

* **provisioning:** add import to 10 override-only providers (batch 5) ([#85](https://github.com/go-to-k/cdkd/issues/85)) ([f80fcab](https://github.com/go-to-k/cdkd/commit/f80fcab1805017d25a0cb9f588df8411464347ad))

# [0.21.0](https://github.com/go-to-k/cdkd/compare/v0.20.0...v0.21.0) (2026-05-02)


### Features

* **provisioning:** add import to 8 more SDK providers (batch 4) ([#86](https://github.com/go-to-k/cdkd/issues/86)) ([126d820](https://github.com/go-to-k/cdkd/commit/126d82096c543ea21a82c1775824cfcbe3e330c3))

# [0.20.0](https://github.com/go-to-k/cdkd/compare/v0.19.0...v0.20.0) (2026-05-02)


### Features

* **provisioning:** add import to 10 more SDK providers (batch 3) ([#82](https://github.com/go-to-k/cdkd/issues/82)) ([775ff26](https://github.com/go-to-k/cdkd/commit/775ff260e58033fa65855d50d5826749138c7611))

# [0.19.0](https://github.com/go-to-k/cdkd/compare/v0.18.1...v0.19.0) (2026-05-02)


### Features

* **provisioning:** add import to 6 more SDK providers (batch 2) ([#80](https://github.com/go-to-k/cdkd/issues/80)) ([139dcc6](https://github.com/go-to-k/cdkd/commit/139dcc644ba81b1389f8f0edac84aab9f019781f))

## [0.18.1](https://github.com/go-to-k/cdkd/compare/v0.18.0...v0.18.1) (2026-05-02)


### Bug Fixes

* **cli:** buffer per-stack log output during parallel deploy ([#77](https://github.com/go-to-k/cdkd/issues/77)) ([0275dd3](https://github.com/go-to-k/cdkd/commit/0275dd3edf091e01b08b76c5ee95ad0f4ac12d8d))
* **cli:** scope live renderer tasks per stack for parallel deploys ([#83](https://github.com/go-to-k/cdkd/issues/83)) ([40b4997](https://github.com/go-to-k/cdkd/commit/40b4997c2885d68fc353038f4ce62774d2323ce2))

# [0.18.0](https://github.com/go-to-k/cdkd/compare/v0.17.1...v0.18.0) (2026-05-02)


### Features

* rename state rm to orphan + add cdkd orphan + 0.x-friendly releaseRules ([#79](https://github.com/go-to-k/cdkd/issues/79)) ([dc701dd](https://github.com/go-to-k/cdkd/commit/dc701dd1aa365b8b0d9a1e98f1c16d9079bd00fb))

## [0.17.1](https://github.com/go-to-k/cdkd/compare/v0.17.0...v0.17.1) (2026-05-01)


### Bug Fixes

* **provisioning:** scope resource-name stack prefix per async context (parallel deploy bug) ([#74](https://github.com/go-to-k/cdkd/issues/74)) ([1b5fb83](https://github.com/go-to-k/cdkd/commit/1b5fb834206e9051d285332265f181cf60709a78))

# [0.17.0](https://github.com/go-to-k/cdkd/compare/v0.16.1...v0.17.0) (2026-05-01)


### Features

* **provisioning:** add import to EC2, RDS, ECS, CloudFront, ApiGateway, Cognito providers ([#73](https://github.com/go-to-k/cdkd/issues/73)) ([255cab1](https://github.com/go-to-k/cdkd/commit/255cab1588395f3463f7dc9352e9823e242cd116))

## [0.16.1](https://github.com/go-to-k/cdkd/compare/v0.16.0...v0.16.1) (2026-05-01)


### Bug Fixes

* **cli:** fall back to legacy bucket when new is empty and legacy has state ([#72](https://github.com/go-to-k/cdkd/issues/72)) ([b48fd5d](https://github.com/go-to-k/cdkd/commit/b48fd5d9d4e7e888ab1ca1e5e6f2d2a5ed6facf4))

# [0.16.0](https://github.com/go-to-k/cdkd/compare/v0.15.0...v0.16.0) (2026-05-01)


### Features

* **provisioning:** add import to CloudControlProvider (explicit-override only) ([#71](https://github.com/go-to-k/cdkd/issues/71)) ([80739cc](https://github.com/go-to-k/cdkd/commit/80739cc31f531fbcb748653750c84e223a15dfd2))

# [0.15.0](https://github.com/go-to-k/cdkd/compare/v0.14.0...v0.15.0) (2026-05-01)


### Features

* **cli:** add cdkd import for adopting AWS-deployed resources ([#67](https://github.com/go-to-k/cdkd/issues/67)) ([f1cad24](https://github.com/go-to-k/cdkd/commit/f1cad2438868b48c56f5e268d1d0ea8ac4b958bf))

# [0.14.0](https://github.com/go-to-k/cdkd/compare/v0.13.0...v0.14.0) (2026-05-01)


### Features

* **cli:** add cdkd state migrate-bucket ([#66](https://github.com/go-to-k/cdkd/issues/66)) ([33dfd9b](https://github.com/go-to-k/cdkd/commit/33dfd9bc4e7dabca4b7d42fd60dfd54a962f4af5))

# [0.13.0](https://github.com/go-to-k/cdkd/compare/v0.12.0...v0.13.0) (2026-05-01)


### Features

* **cli:** hide state bucket from default output, add cdkd state info ([#59](https://github.com/go-to-k/cdkd/issues/59)) ([03b3bd8](https://github.com/go-to-k/cdkd/commit/03b3bd817ffe657c10363b4fc436c9aae153e2f7))

# [0.12.0](https://github.com/go-to-k/cdkd/compare/v0.11.0...v0.12.0) (2026-05-01)


### Features

* **cli:** cdkd state destroy command (CDK-app-free destroy) ([#58](https://github.com/go-to-k/cdkd/issues/58)) ([cacc26c](https://github.com/go-to-k/cdkd/commit/cacc26c81399032de775015a3bd60a02dda003cc))

# [0.11.0](https://github.com/go-to-k/cdkd/compare/v0.10.0...v0.11.0) (2026-05-01)


### Features

* **state:** default bucket name without region (cdkd-state-{accountId}) ([#62](https://github.com/go-to-k/cdkd/issues/62)) ([11a676c](https://github.com/go-to-k/cdkd/commit/11a676cb8b571d462f1de03568b3665295997eae))

# [0.10.0](https://github.com/go-to-k/cdkd/compare/v0.9.0...v0.10.0) (2026-05-01)


### Features

* **state:** dynamic state-bucket region resolution + UnknownError normalization ([#60](https://github.com/go-to-k/cdkd/issues/60)) ([d0056cd](https://github.com/go-to-k/cdkd/commit/d0056cd6fcc85fa78f2ff071ecfc5957fb8bf3cf))

# [0.9.0](https://github.com/go-to-k/cdkd/compare/v0.8.0...v0.9.0) (2026-05-01)


### Features

* **provisioning:** verify region match before idempotent NotFound on delete ([#61](https://github.com/go-to-k/cdkd/issues/61)) ([ab8f1f6](https://github.com/go-to-k/cdkd/commit/ab8f1f613369d5f7f533eb756b326448ace9b263))

# [0.8.0](https://github.com/go-to-k/cdkd/compare/v0.7.0...v0.8.0) (2026-05-01)


### Features

* **state:** region-prefixed state key (collection model extension) ([#57](https://github.com/go-to-k/cdkd/issues/57)) ([83e5ddb](https://github.com/go-to-k/cdkd/commit/83e5ddb66ca4a2923aba1f9ccc106c4411864ae6))

# [0.7.0](https://github.com/go-to-k/cdkd/compare/v0.6.0...v0.7.0) (2026-04-29)


### Features

* **cli:** physical stack name in cdkd list + spec-correct empty containers in toYaml + PR-readiness infra ([#55](https://github.com/go-to-k/cdkd/issues/55)) ([3353c47](https://github.com/go-to-k/cdkd/commit/3353c47d492f3790e93b31e0180f809759a4d813))

# [0.6.0](https://github.com/go-to-k/cdkd/compare/v0.5.1...v0.6.0) (2026-04-29)


### Features

* **cli:** add state command (list/resources/show/rm subcommands) ([#53](https://github.com/go-to-k/cdkd/issues/53)) ([5818f82](https://github.com/go-to-k/cdkd/commit/5818f826a4abbe43bebc1ee9dd1db8178431c79e))

## [0.5.1](https://github.com/go-to-k/cdkd/compare/v0.5.0...v0.5.1) (2026-04-29)


### Performance Improvements

* **deploy:** faster CREATE retry backoff (1s init + 8s cap) ([#54](https://github.com/go-to-k/cdkd/issues/54)) ([2df06a7](https://github.com/go-to-k/cdkd/commit/2df06a770bb2cc30f95093dce522df7243b5da48))

# [0.5.0](https://github.com/go-to-k/cdkd/compare/v0.4.1...v0.5.0) (2026-04-29)


### Features

* **cli:** add list/ls command (CDK CLI parity) ([#52](https://github.com/go-to-k/cdkd/issues/52)) ([c1222f4](https://github.com/go-to-k/cdkd/commit/c1222f4edfccc569bfc3670ec87a01cb45ef21a0))

## [0.4.1](https://github.com/go-to-k/cdkd/compare/v0.4.0...v0.4.1) (2026-04-29)


### Bug Fixes

* **deploy:** retry CW Logs SubscriptionFilter test-message probe ([#51](https://github.com/go-to-k/cdkd/issues/51)) ([271bafe](https://github.com/go-to-k/cdkd/commit/271bafe85a0651b4192324c197da98bf37fd8600))

# [0.4.0](https://github.com/go-to-k/cdkd/compare/v0.3.6...v0.4.0) (2026-04-29)


### Features

* **cli:** accept CDK display path (Stage/Stack) for stack selection ([#49](https://github.com/go-to-k/cdkd/issues/49)) ([e365fdf](https://github.com/go-to-k/cdkd/commit/e365fdf38cda0a8db0250c9f10e5f3c41c95ab3a))
* **cli:** live multi-line progress display for in-flight resources ([#48](https://github.com/go-to-k/cdkd/issues/48)) ([9843d38](https://github.com/go-to-k/cdkd/commit/9843d38c4bcb2082e4cad917ef4240b5c8a11850))

## [0.3.6](https://github.com/go-to-k/cdkd/compare/v0.3.5...v0.3.6) (2026-04-29)


### Bug Fixes

* **lambda,ec2:** filter ENI by description, not requester-id ([#45](https://github.com/go-to-k/cdkd/issues/45)) ([cf2ab1a](https://github.com/go-to-k/cdkd/commit/cf2ab1a7ce020e371a2b8360069816993109f9d0))

## [0.3.5](https://github.com/go-to-k/cdkd/compare/v0.3.4...v0.3.5) (2026-04-29)


### Bug Fixes

* **lambda:** widen per-ENI delete budget to 30min for AWS eventually-consistent release ([#44](https://github.com/go-to-k/cdkd/issues/44)) ([4db7663](https://github.com/go-to-k/cdkd/commit/4db766344ca542af2fa8690a25d0b1fb30dd9162))

## [0.3.4](https://github.com/go-to-k/cdkd/compare/v0.3.3...v0.3.4) (2026-04-29)


### Bug Fixes

* **lambda,ec2:** delstack-style ENI cleanup + EC2 side-channel retry ([#43](https://github.com/go-to-k/cdkd/issues/43)) ([5241e1f](https://github.com/go-to-k/cdkd/commit/5241e1fbad9c6a0b69bf98fe15c53f40400c2859))

## [0.3.3](https://github.com/go-to-k/cdkd/compare/v0.3.2...v0.3.3) (2026-04-29)


### Bug Fixes

* **lambda:** wait for VPC detach to fully apply before DeleteFunction ([#42](https://github.com/go-to-k/cdkd/issues/42)) ([6de7acb](https://github.com/go-to-k/cdkd/commit/6de7acb1cfce2662b1ccf474c2de5748ad1d7f86))

## [0.3.2](https://github.com/go-to-k/cdkd/compare/v0.3.1...v0.3.2) (2026-04-29)


### Bug Fixes

* **lambda:** match ENI description by token prefix, not full physicalId regex ([#41](https://github.com/go-to-k/cdkd/issues/41)) ([74331ce](https://github.com/go-to-k/cdkd/commit/74331ce49548938d054803becaa753dd83a84526))

## [0.3.1](https://github.com/go-to-k/cdkd/compare/v0.3.0...v0.3.1) (2026-04-28)


### Bug Fixes

* **lambda:** detach VPC + actively delete ENIs before downstream cleanup ([#38](https://github.com/go-to-k/cdkd/issues/38)) ([cc3a9a6](https://github.com/go-to-k/cdkd/commit/cc3a9a6981a5f86503dd3e237b46f6fb3ee86fcc))

# [0.3.0](https://github.com/go-to-k/cdkd/compare/v0.2.0...v0.3.0) (2026-04-28)


### Bug Fixes

* **cloudfront:** wait for Enabled=false to propagate before delete ([#33](https://github.com/go-to-k/cdkd/issues/33)) ([482c071](https://github.com/go-to-k/cdkd/commit/482c071c25c47f285102b9d02e4c32b28d7c98c9))
* **deploy:** force Subnet/SG to wait for Lambda::Function on delete ([#37](https://github.com/go-to-k/cdkd/issues/37)) ([7bfaa5f](https://github.com/go-to-k/cdkd/commit/7bfaa5fe35a0781a2afe985518d0991bfcd959f9))


### Features

* **provider:** handle Lambda VpcConfig + wait for ENI detach on delete ([#35](https://github.com/go-to-k/cdkd/issues/35)) ([51d3de7](https://github.com/go-to-k/cdkd/commit/51d3de76831fce4f299b04da5f65fc097627714c))
* **provider:** handle SecurityGroupEgress on AWS::EC2::SecurityGroup ([#34](https://github.com/go-to-k/cdkd/issues/34)) ([d69b6b9](https://github.com/go-to-k/cdkd/commit/d69b6b91c718bc7606acdabda82882b9e96ef3ab))

# [0.2.0](https://github.com/go-to-k/cdkd/compare/v0.1.0...v0.2.0) (2026-04-27)


### Features

* **deployment:** event-driven DAG dispatch (no level barriers) ([#30](https://github.com/go-to-k/cdkd/issues/30)) ([bffd25d](https://github.com/go-to-k/cdkd/commit/bffd25db80a076956626bb941d6572ec170b60cb))

# [0.1.0](https://github.com/go-to-k/cdkd/compare/v0.0.4...v0.1.0) (2026-04-27)


### Features

* **cli:** add -y/--yes global flag, -a alias, accept assembly dir for --app ([#28](https://github.com/go-to-k/cdkd/issues/28)) ([1f51bb9](https://github.com/go-to-k/cdkd/commit/1f51bb9b8415913bf454885399789125b48f6ff6))

## [0.0.4](https://github.com/go-to-k/cdkd/compare/v0.0.3...v0.0.4) (2026-04-24)


### Bug Fixes

* **analyzer:** add implicit Custom Resource policy edge; split commit gate ([#27](https://github.com/go-to-k/cdkd/issues/27)) ([19b59b5](https://github.com/go-to-k/cdkd/commit/19b59b59dcf281b13c99fb921857ef2a3de5589a))

## [0.0.3](https://github.com/go-to-k/cdkd/compare/v0.0.2...v0.0.3) (2026-04-23)


### Bug Fixes

* **cli:** verify state bucket exists before synth and asset publishing ([#25](https://github.com/go-to-k/cdkd/issues/25)) ([cfe1b63](https://github.com/go-to-k/cdkd/commit/cfe1b630a40d6ad00a57bfe38e8c8b255768e55c))

## [0.0.2](https://github.com/go-to-k/cdkd/compare/v0.0.1...v0.0.2) (2026-04-23)


### Bug Fixes

* **cli:** report real version via build-time package.json injection ([#23](https://github.com/go-to-k/cdkd/issues/23)) ([edca82b](https://github.com/go-to-k/cdkd/commit/edca82b5172bfc2426cbea692a681f71e6ef05c9))
