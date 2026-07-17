## [0.238.4](https://github.com/go-to-k/cdkd/compare/v0.238.3...v0.238.4) (2026-07-17)


### Bug Fixes

* **state:** stop persisting template Parameter names into resource dependencies ([#1037](https://github.com/go-to-k/cdkd/issues/1037)) ([27e196b](https://github.com/go-to-k/cdkd/commit/27e196b629b2a1f62706dd41ed08c94855c59b2c))

## [0.238.3](https://github.com/go-to-k/cdkd/compare/v0.238.2...v0.238.3) (2026-07-17)


### Bug Fixes

* **diff:** bind template Parameters and evaluate Conditions like deploy; skip condition-false Outputs ([#1033](https://github.com/go-to-k/cdkd/issues/1033)) ([14a84c3](https://github.com/go-to-k/cdkd/commit/14a84c386d2ec3140b76b5cd15e48fc3ac4dcd5e))

## [0.238.2](https://github.com/go-to-k/cdkd/compare/v0.238.1...v0.238.2) (2026-07-16)


### Bug Fixes

* **provisioning:** add no-op SDK provider for AWS::CloudFormation::WaitConditionHandle ([#1029](https://github.com/go-to-k/cdkd/issues/1029)) ([e1ba3fc](https://github.com/go-to-k/cdkd/commit/e1ba3fcab78cbf94ed1c1a53036397ac69ff8be8))

## [0.238.1](https://github.com/go-to-k/cdkd/compare/v0.238.0...v0.238.1) (2026-07-16)


### Bug Fixes

* **diff:** render unresolved intrinsics as known-after-deploy instead of 'undefined' and quiet the diff-context Ref-not-found warn ([#1024](https://github.com/go-to-k/cdkd/issues/1024)) ([5b4f653](https://github.com/go-to-k/cdkd/commit/5b4f65302e56132fd9b30c6080ad06c2ce810112))
* **diff:** skip cloudformation:DescribeType for custom resource types in replacement detection ([#1023](https://github.com/go-to-k/cdkd/issues/1023)) ([d5647f8](https://github.com/go-to-k/cdkd/commit/d5647f8f23ee27ecd5f0182fb1bfbe7063cbb338))

# [0.238.0](https://github.com/go-to-k/cdkd/compare/v0.237.0...v0.238.0) (2026-07-16)


### Features

* **gc:** garbage-collect unreferenced objects/images from cdkd-owned asset storage ([#1022](https://github.com/go-to-k/cdkd/issues/1022)) ([fbc2e05](https://github.com/go-to-k/cdkd/commit/fbc2e05f884360c2c4b8da16266cb190b6078e98))

# [0.237.0](https://github.com/go-to-k/cdkd/compare/v0.236.0...v0.237.0) (2026-07-16)


### Features

* **bootstrap:** support custom asset storage names via --asset-bucket / --container-repo ([#1021](https://github.com/go-to-k/cdkd/issues/1021)) ([b5f8399](https://github.com/go-to-k/cdkd/commit/b5f839961186b05f25d0c8d2d0213effd39194ed))

# [0.236.0](https://github.com/go-to-k/cdkd/compare/v0.235.1...v0.236.0) (2026-07-16)


### Features

* **bootstrap:** add --destroy teardown for cdkd-created account resources ([#1018](https://github.com/go-to-k/cdkd/issues/1018)) ([0d7aa08](https://github.com/go-to-k/cdkd/commit/0d7aa08074ffb89458beb8ede4d6668c8ef7bfcf))

## [0.235.1](https://github.com/go-to-k/cdkd/compare/v0.235.0...v0.235.1) (2026-07-16)


### Bug Fixes

* **state:** pass ExpectedBucketOwner on every state-bucket-family S3 call ([#1015](https://github.com/go-to-k/cdkd/issues/1015)) ([36d6118](https://github.com/go-to-k/cdkd/commit/36d611829baa16eb012ac431d00a9c693e80ada9))

# [0.235.0](https://github.com/go-to-k/cdkd/compare/v0.234.1...v0.235.0) (2026-07-16)


### Features

* **assets:** auto-create per-region asset storage on first deploy ([#1008](https://github.com/go-to-k/cdkd/issues/1008)) ([ddb811f](https://github.com/go-to-k/cdkd/commit/ddb811ffc12ec5ec42419f4a26f2c64db9bdb1d4))

## [0.234.1](https://github.com/go-to-k/cdkd/compare/v0.234.0...v0.234.1) (2026-07-16)


### Bug Fixes

* **bootstrap:** make cdk-bootstrap-free deploys work end-to-end ([#1006](https://github.com/go-to-k/cdkd/issues/1006)) ([848b454](https://github.com/go-to-k/cdkd/commit/848b454863e6404712a816fa589988610b6d57c6))

# [0.234.0](https://github.com/go-to-k/cdkd/compare/v0.233.0...v0.234.0) (2026-07-15)


### Features

* **local:** recognize cdkd-owned + custom-qualifier container-assets images in run-task ([#1005](https://github.com/go-to-k/cdkd/issues/1005)) ([1f407c0](https://github.com/go-to-k/cdkd/commit/1f407c00bb3569030fbcb55bc0479ea92468628f))

# [0.233.0](https://github.com/go-to-k/cdkd/compare/v0.232.0...v0.233.0) (2026-07-15)


### Features

* **assets:** redirect asset publishing to cdkd-owned storage + rewrite template references (issue [#1002](https://github.com/go-to-k/cdkd/issues/1002), PR 2 of 3) ([#1004](https://github.com/go-to-k/cdkd/issues/1004)) ([5da8fd4](https://github.com/go-to-k/cdkd/commit/5da8fd415e5e938760b6e14240495ea767c6b8e7))

# [0.232.0](https://github.com/go-to-k/cdkd/compare/v0.231.12...v0.232.0) (2026-07-15)


### Features

* **bootstrap:** cdkd-owned asset storage + per-region marker + deploy-time asset-mode detection (issue [#1002](https://github.com/go-to-k/cdkd/issues/1002), PR 1 of 3) ([#1003](https://github.com/go-to-k/cdkd/issues/1003)) ([ba6b6d8](https://github.com/go-to-k/cdkd/commit/ba6b6d846cc1104a9585768ae947041f63335d0e))

## [0.231.12](https://github.com/go-to-k/cdkd/compare/v0.231.11...v0.231.12) (2026-07-03)


### Bug Fixes

* **deployment:** Ref on AWS::Backup::BackupSelection returns the bare SelectionId ([#996](https://github.com/go-to-k/cdkd/issues/996)) ([4ffa0ac](https://github.com/go-to-k/cdkd/commit/4ffa0acf05dfc4154943fd2ebdef709c4385b122))

## [0.231.11](https://github.com/go-to-k/cdkd/compare/v0.231.10...v0.231.11) (2026-07-03)


### Bug Fixes

* **provisioning:** wait for table ACTIVE after DynamoDB OnDemand/Warm throughput update ([#994](https://github.com/go-to-k/cdkd/issues/994)) ([93415a2](https://github.com/go-to-k/cdkd/commit/93415a2fec18a9e2108e56749eea3f9b5b22c728))

## [0.231.10](https://github.com/go-to-k/cdkd/compare/v0.231.9...v0.231.10) (2026-07-03)


### Bug Fixes

* **deployment:** propagate in-place GetAtt value changes to NO_CHANGE dependents ([#993](https://github.com/go-to-k/cdkd/issues/993)) ([58d144c](https://github.com/go-to-k/cdkd/commit/58d144c9da7a015a08e7455aacf573f675983c5c))

## [0.231.9](https://github.com/go-to-k/cdkd/compare/v0.231.8...v0.231.9) (2026-07-03)


### Bug Fixes

* **deployment:** enrich Fn::GetAtt attributes for CC-routed AWS::Backup resources ([#992](https://github.com/go-to-k/cdkd/issues/992)) ([580f126](https://github.com/go-to-k/cdkd/commit/580f126b3d273e13d1082a6470fc351210688334))

## [0.231.8](https://github.com/go-to-k/cdkd/compare/v0.231.7...v0.231.8) (2026-07-03)


### Bug Fixes

* **provisioning:** create and update SNS inline subscriptions ([#991](https://github.com/go-to-k/cdkd/issues/991)) ([6a52e97](https://github.com/go-to-k/cdkd/commit/6a52e9722e330ffc623019cf26ffb256a912b712))

## [0.231.7](https://github.com/go-to-k/cdkd/compare/v0.231.6...v0.231.7) (2026-07-03)


### Bug Fixes

* **provisioning:** clear removed StepFunctions logging/tracing/encryption config on update ([#990](https://github.com/go-to-k/cdkd/issues/990)) ([051f505](https://github.com/go-to-k/cdkd/commit/051f5053ef3c2c416d7d41856d63c7ab3a42db8b))

## [0.231.6](https://github.com/go-to-k/cdkd/compare/v0.231.5...v0.231.6) (2026-07-03)


### Bug Fixes

* **provisioning:** apply DynamoDB StreamSpecification changes on update ([#989](https://github.com/go-to-k/cdkd/issues/989)) ([13ad843](https://github.com/go-to-k/cdkd/commit/13ad8438abaa91f8f9003913a64209bd4e9cebb7))

## [0.231.5](https://github.com/go-to-k/cdkd/compare/v0.231.4...v0.231.5) (2026-07-03)


### Bug Fixes

* **provisioning:** untag removed ECR repository tags on update ([#988](https://github.com/go-to-k/cdkd/issues/988)) ([15405d2](https://github.com/go-to-k/cdkd/commit/15405d2258c092eba4f4fdcde42317cff9d0ce19))

## [0.231.4](https://github.com/go-to-k/cdkd/compare/v0.231.3...v0.231.4) (2026-07-03)


### Bug Fixes

* **deployment:** resolve CC-routed S3Tables::Table Ref to the table name ([#986](https://github.com/go-to-k/cdkd/issues/986)) ([98cf087](https://github.com/go-to-k/cdkd/commit/98cf0870bf375338b76eda33e8b0dbc99cb3680b))

## [0.231.3](https://github.com/go-to-k/cdkd/compare/v0.231.2...v0.231.3) (2026-07-03)


### Bug Fixes

* **provisioning:** map EnableECSManagedTags / PropagateTags / LoadBalancers / ServiceRegistries into ECS UpdateService ([#983](https://github.com/go-to-k/cdkd/issues/983)) ([d53d0d2](https://github.com/go-to-k/cdkd/commit/d53d0d2a9e67d05c9a10a20400e5a7d418cf72ce))

## [0.231.2](https://github.com/go-to-k/cdkd/compare/v0.231.1...v0.231.2) (2026-07-03)


### Bug Fixes

* **provisioning:** clear removed FilterCriteria/ScalingConfig on Lambda ESM update ([#982](https://github.com/go-to-k/cdkd/issues/982)) ([144bc11](https://github.com/go-to-k/cdkd/commit/144bc11e1dd301defedd1d98848aac3e0ca73a45))

## [0.231.1](https://github.com/go-to-k/cdkd/compare/v0.231.0...v0.231.1) (2026-07-03)


### Bug Fixes

* **deployment:** close out the compound-Ref audit for ECS::Service, S3Tables, and WAFv2::WebACL ([#972](https://github.com/go-to-k/cdkd/issues/972)) ([4d03209](https://github.com/go-to-k/cdkd/commit/4d03209c478b69b280436951aaa611c19c369593))

# [0.231.0](https://github.com/go-to-k/cdkd/compare/v0.230.33...v0.231.0) (2026-07-02)


### Features

* **provisioning:** wire ApiGateway Stage MethodSettings into the SDK provider ([#971](https://github.com/go-to-k/cdkd/issues/971)) ([0d9cdd6](https://github.com/go-to-k/cdkd/commit/0d9cdd6b82091314c8e0dc2eb2499387dfcbcdbe))

## [0.230.33](https://github.com/go-to-k/cdkd/compare/v0.230.32...v0.230.33) (2026-07-02)


### Bug Fixes

* **deployment:** resolve Ref on CC-routed ApiGatewayV2 family to the CFn Ref component ([#969](https://github.com/go-to-k/cdkd/issues/969)) ([2516157](https://github.com/go-to-k/cdkd/commit/251615787aabe0962fe8ffa9ab13b6ca7dabe469))

## [0.230.32](https://github.com/go-to-k/cdkd/compare/v0.230.31...v0.230.32) (2026-07-02)


### Bug Fixes

* **deployment:** actionable error + --replace delete-first for custom-named resource replacement ([#968](https://github.com/go-to-k/cdkd/issues/968)) ([8a0b2d5](https://github.com/go-to-k/cdkd/commit/8a0b2d5f9cc9d78fc9041e4ca2412964e7c751b7))

## [0.230.31](https://github.com/go-to-k/cdkd/compare/v0.230.30...v0.230.31) (2026-07-02)


### Bug Fixes

* **deployment:** resolve Ref on CC-routed ApiGateway Stage/Resource/Authorizer/Deployment/DocumentationPart to the CFn Ref component ([#967](https://github.com/go-to-k/cdkd/issues/967)) ([ee5085c](https://github.com/go-to-k/cdkd/commit/ee5085c675649f6c81f5ca5192bd451fd153f8bc))

## [0.230.30](https://github.com/go-to-k/cdkd/compare/v0.230.29...v0.230.30) (2026-07-02)


### Bug Fixes

* **provisioning:** add AWS::Scheduler::Schedule SDK provider so custom-group schedules are manageable ([#964](https://github.com/go-to-k/cdkd/issues/964)) ([8f6b6ef](https://github.com/go-to-k/cdkd/commit/8f6b6ef49c0aaa55ac3953758354bf147ca7ef48))

## [0.230.29](https://github.com/go-to-k/cdkd/compare/v0.230.28...v0.230.29) (2026-07-02)


### Bug Fixes

* **analyzer:** compare createOnly properties at path granularity, not top-level reduction ([#965](https://github.com/go-to-k/cdkd/issues/965)) ([0d948df](https://github.com/go-to-k/cdkd/commit/0d948df70c31766a06feeab90743fa1b4babbf91))

## [0.230.28](https://github.com/go-to-k/cdkd/compare/v0.230.27...v0.230.28) (2026-07-02)


### Bug Fixes

* **provisioning:** clean up the remnant a failed async Cloud Control CREATE leaves behind ([#957](https://github.com/go-to-k/cdkd/issues/957)) ([b620dfa](https://github.com/go-to-k/cdkd/commit/b620dfa65281e0759889821490a1a2ba9bdffd87))

## [0.230.27](https://github.com/go-to-k/cdkd/compare/v0.230.26...v0.230.27) (2026-07-02)


### Bug Fixes

* **provisioning:** apply LogGroup KmsKeyId change on update (was silently dropped) ([#959](https://github.com/go-to-k/cdkd/issues/959)) ([3a1c408](https://github.com/go-to-k/cdkd/commit/3a1c4082c6e2b959b26fd6ee9ee3fb9ecbc4fa77))

## [0.230.26](https://github.com/go-to-k/cdkd/compare/v0.230.25...v0.230.26) (2026-07-02)


### Bug Fixes

* **provisioning:** reject LogGroupClass change with an actionable error (was silently dropped) ([#954](https://github.com/go-to-k/cdkd/issues/954)) ([d3ad617](https://github.com/go-to-k/cdkd/commit/d3ad6175afa92793a5adc49b6b6f96388cf37885))

## [0.230.25](https://github.com/go-to-k/cdkd/compare/v0.230.24...v0.230.25) (2026-07-02)


### Bug Fixes

* **provisioning:** apply Lambda architecture switch on update (was silently dropped) ([#952](https://github.com/go-to-k/cdkd/issues/952)) ([6d30d5b](https://github.com/go-to-k/cdkd/commit/6d30d5b5aa09c9ae99a7d3339abd8674016c5089))

## [0.230.24](https://github.com/go-to-k/cdkd/compare/v0.230.23...v0.230.24) (2026-07-02)


### Bug Fixes

* **provisioning:** apply DynamoDB TableClass switch on update (was silently dropped) ([#951](https://github.com/go-to-k/cdkd/issues/951)) ([8a95ce0](https://github.com/go-to-k/cdkd/commit/8a95ce0129a849f14fa0ff5a809b4ba01d0935e3))

## [0.230.23](https://github.com/go-to-k/cdkd/compare/v0.230.22...v0.230.23) (2026-07-02)


### Bug Fixes

* **deploy:** retry Step Functions assume-role IAM-propagation race ([#950](https://github.com/go-to-k/cdkd/issues/950)) ([cb3000b](https://github.com/go-to-k/cdkd/commit/cb3000b1f0dc6421574f439e3126aa7bdcd6d7fe))

## [0.230.22](https://github.com/go-to-k/cdkd/compare/v0.230.21...v0.230.22) (2026-07-02)


### Bug Fixes

* **provisioning:** address custom-bus EventBridge rules in delete/getAttribute ([#956](https://github.com/go-to-k/cdkd/issues/956)) ([21ec870](https://github.com/go-to-k/cdkd/commit/21ec870e1ead058352259e75a96df0eb76180073))

## [0.230.21](https://github.com/go-to-k/cdkd/compare/v0.230.20...v0.230.21) (2026-07-02)


### Bug Fixes

* **deployment:** Ref on Events::Rule / CloudTrail::Trail returns the resource name, not the ARN ([#949](https://github.com/go-to-k/cdkd/issues/949)) ([a2a4298](https://github.com/go-to-k/cdkd/commit/a2a4298bfb891260620a924ba5276b3b28da9d6f))

## [0.230.20](https://github.com/go-to-k/cdkd/compare/v0.230.19...v0.230.20) (2026-07-02)


### Bug Fixes

* **deploy:** retry CodeDeploy assume-role IAM-propagation race + accurate sibling-abort message ([#948](https://github.com/go-to-k/cdkd/issues/948)) ([7499068](https://github.com/go-to-k/cdkd/commit/749906833cb0a09e2c55144045db9eef382ab4b6))

## [0.230.19](https://github.com/go-to-k/cdkd/compare/v0.230.18...v0.230.19) (2026-06-29)


### Bug Fixes

* **cli:** say 'Reading cloud assembly' for pre-synth -a across all commands ([#946](https://github.com/go-to-k/cdkd/issues/946)) ([215ba38](https://github.com/go-to-k/cdkd/commit/215ba3891038bf537b0a9d4ef5f41095b3be5192))

## [0.230.18](https://github.com/go-to-k/cdkd/compare/v0.230.17...v0.230.18) (2026-06-29)


### Bug Fixes

* **deploy:** say "Reading cloud assembly" for pre-synth -a + refresh demo GIF ([#945](https://github.com/go-to-k/cdkd/issues/945)) ([e3e74fc](https://github.com/go-to-k/cdkd/commit/e3e74fcf263ab72be6f9527a9b2c8e32871369e3))

## [0.230.17](https://github.com/go-to-k/cdkd/compare/v0.230.16...v0.230.17) (2026-06-29)


### Bug Fixes

* **diff:** detect createOnly-property replacements + guard stateful ones ([#943](https://github.com/go-to-k/cdkd/issues/943)) ([ba64134](https://github.com/go-to-k/cdkd/commit/ba64134cf03c0dba69c39530317639d8c6b5fefd))

## [0.230.16](https://github.com/go-to-k/cdkd/compare/v0.230.15...v0.230.16) (2026-06-29)


### Bug Fixes

* **s3:** handle combined And replication filter (prefix + tags) ([#942](https://github.com/go-to-k/cdkd/issues/942)) ([313cdda](https://github.com/go-to-k/cdkd/commit/313cdda62dafad11e808c0bd1bc393af30fdc06e))

## [0.230.15](https://github.com/go-to-k/cdkd/compare/v0.230.14...v0.230.15) (2026-06-29)


### Bug Fixes

* **diff:** detect nested-map-key removal (symmetric valuesEqual) ([#940](https://github.com/go-to-k/cdkd/issues/940)) ([aac746a](https://github.com/go-to-k/cdkd/commit/aac746a0069374d081f0dbb183c1811bd6a00355))

## [0.230.14](https://github.com/go-to-k/cdkd/compare/v0.230.13...v0.230.14) (2026-06-29)


### Bug Fixes

* **diff:** propagate in-place upstream attribute changes to GetAtt dependents ([#939](https://github.com/go-to-k/cdkd/issues/939)) ([772dd03](https://github.com/go-to-k/cdkd/commit/772dd03f7aed9368670b8fa917f61d019876d5ed))

## [0.230.13](https://github.com/go-to-k/cdkd/compare/v0.230.12...v0.230.13) (2026-06-28)


### Bug Fixes

* **replacement:** replace on immutable Name change for SFN / Events Rule / SSM Param / CW Alarm ([#938](https://github.com/go-to-k/cdkd/issues/938)) ([3db2ee2](https://github.com/go-to-k/cdkd/commit/3db2ee20529595d3146c91ac571b1e2a8e26753c))

## [0.230.12](https://github.com/go-to-k/cdkd/compare/v0.230.11...v0.230.12) (2026-06-28)


### Bug Fixes

* **replacement:** replace on Kinesis Stream / Secret Name change (immutable) ([#937](https://github.com/go-to-k/cdkd/issues/937)) ([d57fdc7](https://github.com/go-to-k/cdkd/commit/d57fdc7c6145fac4bd0832f5c1f8bc455daa6087))

## [0.230.11](https://github.com/go-to-k/cdkd/compare/v0.230.10...v0.230.11) (2026-06-28)


### Bug Fixes

* **s3:** normalize lifecycle rules to one V1/V2 form + fold top-level ObjectSize filters ([#936](https://github.com/go-to-k/cdkd/issues/936)) ([43b7fa9](https://github.com/go-to-k/cdkd/commit/43b7fa9dcc34e35bc5b3a995f305d0f0f1700706))

## [0.230.10](https://github.com/go-to-k/cdkd/compare/v0.230.9...v0.230.10) (2026-06-28)


### Bug Fixes

* **deployment:** resolve Cognito UserPoolUser Ref to its CC compound-id sub-segment ([#935](https://github.com/go-to-k/cdkd/issues/935)) ([61c449b](https://github.com/go-to-k/cdkd/commit/61c449bbfb754c57d2ae05465e75a07a174ae024))

## [0.230.9](https://github.com/go-to-k/cdkd/compare/v0.230.8...v0.230.9) (2026-06-27)


### Bug Fixes

* **provisioning:** actionable error on DynamoDB TTL AttributeName change ([#932](https://github.com/go-to-k/cdkd/issues/932)) ([43d6e38](https://github.com/go-to-k/cdkd/commit/43d6e38e1830d0e674ce29b907ec22e090df48e4))

## [0.230.8](https://github.com/go-to-k/cdkd/compare/v0.230.7...v0.230.8) (2026-06-27)


### Bug Fixes

* **provisioning:** resolve Cognito UserPool-child Ref to its CC compound-id sub-segment ([#930](https://github.com/go-to-k/cdkd/issues/930)) ([13ce689](https://github.com/go-to-k/cdkd/commit/13ce689fd5b86f76ded181fe45daa838c18329bb))

## [0.230.7](https://github.com/go-to-k/cdkd/compare/v0.230.6...v0.230.7) (2026-06-22)


### Bug Fixes

* **provisioning:** correct Cognito immutable-Schema error message + 2 hardenings ([#927](https://github.com/go-to-k/cdkd/issues/927)) ([d96fe5d](https://github.com/go-to-k/cdkd/commit/d96fe5da6d8c3aaab1638b4167c64ebaa07db242))

## [0.230.6](https://github.com/go-to-k/cdkd/compare/v0.230.5...v0.230.6) (2026-06-22)


### Bug Fixes

* **provisioning:** apply Cognito add-custom-attribute on update (was silently dropped) ([#926](https://github.com/go-to-k/cdkd/issues/926)) ([da513f1](https://github.com/go-to-k/cdkd/commit/da513f1a324f10abc2cc5476f8d3dfd45d522067))

## [0.230.5](https://github.com/go-to-k/cdkd/compare/v0.230.4...v0.230.5) (2026-06-22)


### Bug Fixes

* **provisioning:** apply Kinesis StreamMode switch (was silently dropped on update) ([#925](https://github.com/go-to-k/cdkd/issues/925)) ([f50b133](https://github.com/go-to-k/cdkd/commit/f50b13336e5bac07f76995f70a4ecf65487ccce7))

## [0.230.4](https://github.com/go-to-k/cdkd/compare/v0.230.3...v0.230.4) (2026-06-22)


### Bug Fixes

* **deploy:** stop IAM Role phantom drift from sibling Default Policy capture race ([#924](https://github.com/go-to-k/cdkd/issues/924)) ([1832d10](https://github.com/go-to-k/cdkd/commit/1832d1066aa8d58689b1bf9e28d0715c6c8ea2aa))

## [0.230.3](https://github.com/go-to-k/cdkd/compare/v0.230.2...v0.230.3) (2026-06-21)


### Bug Fixes

* **provisioning:** enrich Events Connection/ApiDestination Arn so ApiDestination deploys ([#922](https://github.com/go-to-k/cdkd/issues/922)) ([f49a154](https://github.com/go-to-k/cdkd/commit/f49a1545aeeede7c99b184fc0a10376415f50fdc))

## [0.230.2](https://github.com/go-to-k/cdkd/compare/v0.230.1...v0.230.2) (2026-06-21)


### Bug Fixes

* **provisioning:** add SDK provider for Lambda EventInvokeConfig so async-invoke updates work ([#919](https://github.com/go-to-k/cdkd/issues/919)) ([7d41f24](https://github.com/go-to-k/cdkd/commit/7d41f2416d305fbf0f577b8a38bc6eb2c1c2e74b))

## [0.230.1](https://github.com/go-to-k/cdkd/compare/v0.230.0...v0.230.1) (2026-06-21)


### Bug Fixes

* **provisioning:** map ECR CFn PascalCase scanning/encryption config to SDK camelCase (imageScanOnPush silently dropped) ([#920](https://github.com/go-to-k/cdkd/issues/920)) ([8eef917](https://github.com/go-to-k/cdkd/commit/8eef91723be834c93395b1a7a51ac2c801bcb671))

# [0.230.0](https://github.com/go-to-k/cdkd/compare/v0.229.8...v0.230.0) (2026-06-21)


### Features

* **deploy:** implement the --replace flag + fix Glue S3 encryption silent-drop ([#918](https://github.com/go-to-k/cdkd/issues/918)) ([3c07ab3](https://github.com/go-to-k/cdkd/commit/3c07ab362d2054286404116ec214d128506739c2))

## [0.229.8](https://github.com/go-to-k/cdkd/compare/v0.229.7...v0.229.8) (2026-06-21)


### Bug Fixes

* **provisioning:** replace Lambda LayerVersion on content change instead of failing ([#916](https://github.com/go-to-k/cdkd/issues/916)) ([36b4769](https://github.com/go-to-k/cdkd/commit/36b4769ee0d253175c4a97892009ee7c4e3d90bd))

## [0.229.7](https://github.com/go-to-k/cdkd/compare/v0.229.6...v0.229.7) (2026-06-21)


### Bug Fixes

* **provisioning:** apply DynamoDB SSESpecification changes on update (UpdateTable) ([#914](https://github.com/go-to-k/cdkd/issues/914)) ([71b20f0](https://github.com/go-to-k/cdkd/commit/71b20f05dd673b69a41a41a7b03e8aec97db2659))

## [0.229.6](https://github.com/go-to-k/cdkd/compare/v0.229.5...v0.229.6) (2026-06-21)


### Bug Fixes

* **provisioning:** map DynamoDB SSESpecification.SSEEnabled to the SDK Enabled field ([#909](https://github.com/go-to-k/cdkd/issues/909)) ([c05f553](https://github.com/go-to-k/cdkd/commit/c05f55314016a1c4d0939490e7cf1f9e1d592ebb))

## [0.229.5](https://github.com/go-to-k/cdkd/compare/v0.229.4...v0.229.5) (2026-06-21)


### Bug Fixes

* **deploy:** resolve Ref of AppConfig compound-id resources to the trailing id segment ([#905](https://github.com/go-to-k/cdkd/issues/905)) ([3a503a2](https://github.com/go-to-k/cdkd/commit/3a503a258a52ee242c94bd63192d6a92d1fc6968))

## [0.229.4](https://github.com/go-to-k/cdkd/compare/v0.229.3...v0.229.4) (2026-06-21)


### Bug Fixes

* **deploy:** stop --no-prefix-user-supplied-names from flagging a user name that starts with the stack name ([#903](https://github.com/go-to-k/cdkd/issues/903)) ([4f1d40d](https://github.com/go-to-k/cdkd/commit/4f1d40da6758bd2b4695c7dd9873e5338266da68))

## [0.229.3](https://github.com/go-to-k/cdkd/compare/v0.229.2...v0.229.3) (2026-06-21)


### Bug Fixes

* **deploy:** resolve Ref of Cognito UserPoolClient to client id + add CR-heavy daily-pattern integ fixtures ([#898](https://github.com/go-to-k/cdkd/issues/898)) ([712373b](https://github.com/go-to-k/cdkd/commit/712373b1f340b7a793c19f068c3be53b7d6a08da))

## [0.229.2](https://github.com/go-to-k/cdkd/compare/v0.229.1...v0.229.2) (2026-06-21)


### Bug Fixes

* **deploy:** resolve Ref of API Gateway Model / RequestValidator to the ref segment, not the compound physical id ([#897](https://github.com/go-to-k/cdkd/issues/897)) ([1761c23](https://github.com/go-to-k/cdkd/commit/1761c23ca5f674b666706ca8d7af7e30fc122b1e))

## [0.229.1](https://github.com/go-to-k/cdkd/compare/v0.229.0...v0.229.1) (2026-06-21)


### Bug Fixes

* **deploy:** do not pull weak Fn::GetStackOutput producers into the deploy closure ([#896](https://github.com/go-to-k/cdkd/issues/896)) ([6db2ef9](https://github.com/go-to-k/cdkd/commit/6db2ef903ccb6194047f2ba2f32c84f884479658))

# [0.229.0](https://github.com/go-to-k/cdkd/compare/v0.228.0...v0.229.0) (2026-06-20)


### Features

* **destroy:** add --purge-events to delete event history on clean destroy ([#885](https://github.com/go-to-k/cdkd/issues/885)) ([#890](https://github.com/go-to-k/cdkd/issues/890)) ([2256814](https://github.com/go-to-k/cdkd/commit/2256814869103255d917bc0c5218393a1c6cadb5))

# [0.228.0](https://github.com/go-to-k/cdkd/compare/v0.227.1...v0.228.0) (2026-06-20)


### Features

* **events:** bound + purge the deployment-events store ([#885](https://github.com/go-to-k/cdkd/issues/885)) ([#888](https://github.com/go-to-k/cdkd/issues/888)) ([25fa956](https://github.com/go-to-k/cdkd/commit/25fa956c1fef1c6001e1aca86d03bec05afdd85c))

## [0.227.1](https://github.com/go-to-k/cdkd/compare/v0.227.0...v0.227.1) (2026-06-20)


### Bug Fixes

* **provisioning:** add a DynamoDB GSI in place instead of replacing the table ([#887](https://github.com/go-to-k/cdkd/issues/887)) ([b3bf492](https://github.com/go-to-k/cdkd/commit/b3bf4928a2c04745df21d28a22d37005d981b5ca))

# [0.227.0](https://github.com/go-to-k/cdkd/compare/v0.226.0...v0.227.0) (2026-06-15)


### Features

* **provisioning:** backfill AWS::StepFunctions::StateMachine DefinitionS3Location ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#884](https://github.com/go-to-k/cdkd/issues/884)) ([ef4da12](https://github.com/go-to-k/cdkd/commit/ef4da1210047a7ae4a86092d8341ca146ec75fff))

# [0.226.0](https://github.com/go-to-k/cdkd/compare/v0.225.0...v0.226.0) (2026-06-15)


### Features

* **provisioning:** backfill AWS::ServiceDiscovery::Service ServiceAttributes ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#881](https://github.com/go-to-k/cdkd/issues/881)) ([7df8217](https://github.com/go-to-k/cdkd/commit/7df821746bd75ea523ecfd2eef2d7b86bba81661))

# [0.225.0](https://github.com/go-to-k/cdkd/compare/v0.224.0...v0.225.0) (2026-06-15)


### Features

* **provisioning:** backfill AWS::ApiGatewayV2::Authorizer AuthorizerCredentialsArn ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#880](https://github.com/go-to-k/cdkd/issues/880)) ([68567a9](https://github.com/go-to-k/cdkd/commit/68567a97a5a2b4e058241b2a72822e2015a8cf59))

# [0.224.0](https://github.com/go-to-k/cdkd/compare/v0.223.4...v0.224.0) (2026-06-15)


### Features

* **provisioning:** backfill AWS::ElasticLoadBalancingV2::Listener ListenerAttributes ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#879](https://github.com/go-to-k/cdkd/issues/879)) ([254078a](https://github.com/go-to-k/cdkd/commit/254078adcb41718bbf44d02e1921628ba4469369))

## [0.223.4](https://github.com/go-to-k/cdkd/compare/v0.223.3...v0.223.4) (2026-06-15)


### Bug Fixes

* **deploy:** warn when a no-change-path Outputs resolution suppresses persist ([#875](https://github.com/go-to-k/cdkd/issues/875) follow-up) ([#878](https://github.com/go-to-k/cdkd/issues/878)) ([cf4c6f1](https://github.com/go-to-k/cdkd/commit/cf4c6f1cc89ce5b6545f2e478cf417a4f9c1b724))

## [0.223.3](https://github.com/go-to-k/cdkd/compare/v0.223.2...v0.223.3) (2026-06-15)


### Bug Fixes

* **deploy:** persist an Outputs-only change on a no-resource-diff deploy ([#877](https://github.com/go-to-k/cdkd/issues/877)) ([f14ed0e](https://github.com/go-to-k/cdkd/commit/f14ed0e2d3d96ac7a41c5e2cc8874fd69afd789f))

## [0.223.2](https://github.com/go-to-k/cdkd/compare/v0.223.1...v0.223.2) (2026-06-15)


### Bug Fixes

* **provisioning:** stop unwrapping CloudFront OriginGroups in drift readback ([#876](https://github.com/go-to-k/cdkd/issues/876)) ([95a4614](https://github.com/go-to-k/cdkd/commit/95a46149ba5fc9a71de50b9f54d2a605b2efd505))

## [0.223.1](https://github.com/go-to-k/cdkd/compare/v0.223.0...v0.223.1) (2026-06-15)


### Bug Fixes

* **provisioning:** canonicalize CloudFront OAI principals in S3 BucketPolicy drift readback ([#874](https://github.com/go-to-k/cdkd/issues/874)) ([77e32ea](https://github.com/go-to-k/cdkd/commit/77e32eae6e3519d85a59caf56d3887292c67b4dc))

# [0.223.0](https://github.com/go-to-k/cdkd/compare/v0.222.1...v0.223.0) (2026-06-15)


### Features

* **provisioning:** CloudFrontDistributionProvider.readCurrentState + getDriftUnknownPaths ([#871](https://github.com/go-to-k/cdkd/issues/871)) ([7cdf202](https://github.com/go-to-k/cdkd/commit/7cdf202cb1472c98130cbc6ea06493f76ad04957))

## [0.222.1](https://github.com/go-to-k/cdkd/compare/v0.222.0...v0.222.1) (2026-06-15)


### Bug Fixes

* **provisioning:** harden Glue Job/Crawler/Trigger/Workflow update + delete (5 bugs) ([#870](https://github.com/go-to-k/cdkd/issues/870)) ([09ab675](https://github.com/go-to-k/cdkd/commit/09ab675721485499b39f9d2c83bc21ad13a76a8d))

# [0.222.0](https://github.com/go-to-k/cdkd/compare/v0.221.16...v0.222.0) (2026-06-15)


### Features

* **provisioning:** CC-API enrichment-coverage matrix + CI critic ([#869](https://github.com/go-to-k/cdkd/issues/869)) ([e55ff37](https://github.com/go-to-k/cdkd/commit/e55ff37f62379055c1a5b6e8804a33412e8b60f1))

## [0.221.16](https://github.com/go-to-k/cdkd/compare/v0.221.15...v0.221.16) (2026-06-15)


### Bug Fixes

* **provisioning:** implement DynamoDB Table BillingMode/ProvisionedThroughput in-place update (was a silent no-op) ([#868](https://github.com/go-to-k/cdkd/issues/868)) ([56c3562](https://github.com/go-to-k/cdkd/commit/56c35620011652614245ce65b0f7bf5694faac3f))

## [0.221.15](https://github.com/go-to-k/cdkd/compare/v0.221.14...v0.221.15) (2026-06-14)


### Bug Fixes

* **provisioning:** implement S3Vectors::VectorBucket in-place Tags update (was a silent no-op) ([#867](https://github.com/go-to-k/cdkd/issues/867)) ([d24115f](https://github.com/go-to-k/cdkd/commit/d24115f761aa97028bbe91c958576c4358f77119))

## [0.221.14](https://github.com/go-to-k/cdkd/compare/v0.221.13...v0.221.14) (2026-06-14)


### Bug Fixes

* **provisioning:** enrich AWS::OpenSearchService::Domain endpoint/ARN attributes on the Cloud Control path ([#866](https://github.com/go-to-k/cdkd/issues/866)) ([f2dc68f](https://github.com/go-to-k/cdkd/commit/f2dc68fc4cb55ee2eb80b3429ab4f077d45dbd90))

## [0.221.13](https://github.com/go-to-k/cdkd/compare/v0.221.12...v0.221.13) (2026-06-14)


### Bug Fixes

* **provisioning:** enrich AWS::Redshift::Cluster endpoint attributes on the Cloud Control path ([#865](https://github.com/go-to-k/cdkd/issues/865)) ([e349799](https://github.com/go-to-k/cdkd/commit/e34979974e10e8650acad12d005b1bc07c6fff4d))

## [0.221.12](https://github.com/go-to-k/cdkd/compare/v0.221.11...v0.221.12) (2026-06-14)


### Bug Fixes

* **provisioning:** enrich ElastiCache ReplicationGroup endpoint attributes on the Cloud Control path ([#864](https://github.com/go-to-k/cdkd/issues/864)) ([efab00f](https://github.com/go-to-k/cdkd/commit/efab00f688cd0a9e193f04d47a65063404006bc6))

## [0.221.11](https://github.com/go-to-k/cdkd/compare/v0.221.10...v0.221.11) (2026-06-14)


### Bug Fixes

* **deployment:** retry AWS throttling that surfaces as HTTP 400 by error name ([#861](https://github.com/go-to-k/cdkd/issues/861)) ([867f9d3](https://github.com/go-to-k/cdkd/commit/867f9d3293abfccf42f9d532c3adc8af0a5f3010))

## [0.221.10](https://github.com/go-to-k/cdkd/compare/v0.221.9...v0.221.10) (2026-06-14)


### Bug Fixes

* **deployment:** parse secretsmanager whole-secret dynamic-reference form ([#860](https://github.com/go-to-k/cdkd/issues/860)) ([3261b6b](https://github.com/go-to-k/cdkd/commit/3261b6b4fe15655cfd85813f9274eee28af00fb5))

## [0.221.9](https://github.com/go-to-k/cdkd/compare/v0.221.8...v0.221.9) (2026-06-14)


### Bug Fixes

* **deployment:** resolve CompositeAlarm/EC2 GetAtt attributes + CompositeAlarm delete ordering ([#851](https://github.com/go-to-k/cdkd/issues/851)) ([da5d976](https://github.com/go-to-k/cdkd/commit/da5d97618ef916ac1cb5ed30ff5a724303cce022))

## [0.221.8](https://github.com/go-to-k/cdkd/compare/v0.221.7...v0.221.8) (2026-06-14)


### Bug Fixes

* **provisioning:** retry KMS fresh-principal policy + bind EC2 IAM instance profile post-launch ([#848](https://github.com/go-to-k/cdkd/issues/848)) ([afd5c63](https://github.com/go-to-k/cdkd/commit/afd5c63eecbdb198bc21c66bd523c154b4ee6959))

## [0.221.7](https://github.com/go-to-k/cdkd/compare/v0.221.6...v0.221.7) (2026-06-14)


### Bug Fixes

* **deployment:** Fn::FindInMap DefaultValue + Fn::Sub escape + Fn::GetAtt dynamic attribute name ([#852](https://github.com/go-to-k/cdkd/issues/852)) ([b285bab](https://github.com/go-to-k/cdkd/commit/b285babbbb11c11633bc32adf1b605510f0f6146))

## [0.221.6](https://github.com/go-to-k/cdkd/compare/v0.221.5...v0.221.6) (2026-06-14)


### Bug Fixes

* **provisioning:** clear SQS attributes removed on UPDATE (Fn::If -> AWS::NoValue) ([#850](https://github.com/go-to-k/cdkd/issues/850)) ([dd91172](https://github.com/go-to-k/cdkd/commit/dd9117242a34cf565b852f1b93571760833f5f55))

## [0.221.5](https://github.com/go-to-k/cdkd/compare/v0.221.4...v0.221.5) (2026-06-14)


### Bug Fixes

* **cli:** forward resolved nested-stack Parameters in cdkd diff --recursive (no spurious changes) ([#849](https://github.com/go-to-k/cdkd/issues/849)) ([ae2281f](https://github.com/go-to-k/cdkd/commit/ae2281fc03d9306ec2daded37798fe30d64cae1d))

## [0.221.4](https://github.com/go-to-k/cdkd/compare/v0.221.3...v0.221.4) (2026-06-13)


### Bug Fixes

* **deployment:** resolve composite conditions + prune Condition-gated resources on update ([#840](https://github.com/go-to-k/cdkd/issues/840)) ([#846](https://github.com/go-to-k/cdkd/issues/846)) ([5aa7ca4](https://github.com/go-to-k/cdkd/commit/5aa7ca420f2a71de256e286d4bb81b478f40f000))

## [0.221.3](https://github.com/go-to-k/cdkd/compare/v0.221.2...v0.221.3) (2026-06-13)


### Bug Fixes

* **deployment:** Fn::Join over list-returning intrinsics + AWS::NotificationARNs in Fn::Sub ([#838](https://github.com/go-to-k/cdkd/issues/838)) ([#847](https://github.com/go-to-k/cdkd/issues/847)) ([78d239a](https://github.com/go-to-k/cdkd/commit/78d239a0a185e4034aa15ab5e6cf4ff32128316c))

## [0.221.2](https://github.com/go-to-k/cdkd/compare/v0.221.1...v0.221.2) (2026-06-13)


### Bug Fixes

* **provisioning:** enrich AWS::RDS::DBInstance Endpoint attributes on the Cloud Control path ([#844](https://github.com/go-to-k/cdkd/issues/844)) ([bc4e44d](https://github.com/go-to-k/cdkd/commit/bc4e44de372c0e8e3226976acac630bdcb3224d7))

## [0.221.1](https://github.com/go-to-k/cdkd/compare/v0.221.0...v0.221.1) (2026-06-13)


### Bug Fixes

* **deployment:** retry SNS/SQS resource-policy create on fresh-role propagation ([#839](https://github.com/go-to-k/cdkd/issues/839)) ([#843](https://github.com/go-to-k/cdkd/issues/843)) ([05a4070](https://github.com/go-to-k/cdkd/commit/05a4070c76b91924437a026f5e14061976b82c4c))

# [0.221.0](https://github.com/go-to-k/cdkd/compare/v0.220.5...v0.221.0) (2026-06-13)


### Features

* **destroy:** graceful SIGINT handling — release lock + preserve state on interrupt ([#826](https://github.com/go-to-k/cdkd/issues/826)) ([06d1c8b](https://github.com/go-to-k/cdkd/commit/06d1c8b1feb87f0c03933abb4ab38fa40c5ec511))

## [0.220.5](https://github.com/go-to-k/cdkd/compare/v0.220.4...v0.220.5) (2026-06-13)


### Bug Fixes

* **provisioning:** convert ECS TaskDefinition volume sub-configurations PascalCase to camelCase ([#825](https://github.com/go-to-k/cdkd/issues/825)) ([2d54d40](https://github.com/go-to-k/cdkd/commit/2d54d40fb7e477f4e5a8e8596bd20f9dc08e1b53))

## [0.220.4](https://github.com/go-to-k/cdkd/compare/v0.220.3...v0.220.4) (2026-06-13)


### Bug Fixes

* **state:** resolve state bucket region in exports index store ([#824](https://github.com/go-to-k/cdkd/issues/824)) ([663f6bd](https://github.com/go-to-k/cdkd/commit/663f6bd99332172fb5a6052dafb05cb8fe6fd185))

## [0.220.3](https://github.com/go-to-k/cdkd/compare/v0.220.2...v0.220.3) (2026-06-13)


### Bug Fixes

* **analyzer:** order NAT Gateway deletion before IGW / VPCGatewayAttachment on destroy ([#823](https://github.com/go-to-k/cdkd/issues/823)) ([cbeb742](https://github.com/go-to-k/cdkd/commit/cbeb7422fd70ddc09c89d074b27af6fdba5e31ab))

## [0.220.2](https://github.com/go-to-k/cdkd/compare/v0.220.1...v0.220.2) (2026-06-13)


### Bug Fixes

* **cli:** correct warnIfDeprecatedRegion message — --region is still honored, not ignored ([#822](https://github.com/go-to-k/cdkd/issues/822)) ([4ec8230](https://github.com/go-to-k/cdkd/commit/4ec8230196f944c129022be60ee6dbe0a32dad3a))

## [0.220.1](https://github.com/go-to-k/cdkd/compare/v0.220.0...v0.220.1) (2026-06-13)


### Bug Fixes

* **state:** resolve the state bucket's region in LockManager before lock operations ([#821](https://github.com/go-to-k/cdkd/issues/821)) ([5a82714](https://github.com/go-to-k/cdkd/commit/5a82714f224682c1bd388915e8d70ef1191d6330))

# [0.220.0](https://github.com/go-to-k/cdkd/compare/v0.219.9...v0.220.0) (2026-06-13)


### Features

* **deployment:** persist structured deployment events to S3 + cdkd events command ([#820](https://github.com/go-to-k/cdkd/issues/820)) ([de90566](https://github.com/go-to-k/cdkd/commit/de90566586c3fc81169ee0387b296b5175c7e78d))

## [0.219.9](https://github.com/go-to-k/cdkd/compare/v0.219.8...v0.219.9) (2026-06-13)


### Bug Fixes

* **destroy:** persist state incrementally and fail-fast CR delete when backing Lambda is gone ([#814](https://github.com/go-to-k/cdkd/issues/814)) ([29a2e5d](https://github.com/go-to-k/cdkd/commit/29a2e5de58cf9803cbf8f1c930da11edb52c94f6))

## [0.219.8](https://github.com/go-to-k/cdkd/compare/v0.219.7...v0.219.8) (2026-06-13)


### Bug Fixes

* **analyzer:** propagate resource replacement to dependents diffed as NO_CHANGE ([#813](https://github.com/go-to-k/cdkd/issues/813)) ([8c1bd39](https://github.com/go-to-k/cdkd/commit/8c1bd395e835c790e1a908d5706f3262549e0c3e))

## [0.219.7](https://github.com/go-to-k/cdkd/compare/v0.219.6...v0.219.7) (2026-06-13)


### Bug Fixes

* **provisioning:** re-include write-only properties in Cloud Control UPDATE patches ([#812](https://github.com/go-to-k/cdkd/issues/812)) ([7dbc3cb](https://github.com/go-to-k/cdkd/commit/7dbc3cb002a3eba3d076c059442f095737c66175))

## [0.219.6](https://github.com/go-to-k/cdkd/compare/v0.219.5...v0.219.6) (2026-06-13)


### Bug Fixes

* **provisioning:** forward Volumes[].ConfiguredAtLaunch to RegisterTaskDefinition ([#811](https://github.com/go-to-k/cdkd/issues/811)) ([cbe18eb](https://github.com/go-to-k/cdkd/commit/cbe18ebaea78677acce3fbd029a0568e366b288a))

## [0.219.5](https://github.com/go-to-k/cdkd/compare/v0.219.4...v0.219.5) (2026-06-13)


### Bug Fixes

* **deployment:** retry ECS CapacityProvider create on infrastructure-role IAM propagation race ([#810](https://github.com/go-to-k/cdkd/issues/810)) ([cf5ef69](https://github.com/go-to-k/cdkd/commit/cf5ef693be7b8603c3e2f4928860b8c314e1a81e))

## [0.219.4](https://github.com/go-to-k/cdkd/compare/v0.219.3...v0.219.4) (2026-06-11)


### Bug Fixes

* **drift:** canonicalize tag lists and resource-id/ARN arrays before drift comparison ([#802](https://github.com/go-to-k/cdkd/issues/802)) ([c396268](https://github.com/go-to-k/cdkd/commit/c3962680bd1cc196d889793249c850d74c6bb2ad))

## [0.219.3](https://github.com/go-to-k/cdkd/compare/v0.219.2...v0.219.3) (2026-06-10)


### Bug Fixes

* **provisioning:** delegate protected ASG delete from Cloud Control to the SDK ASGProvider ([#798](https://github.com/go-to-k/cdkd/issues/798)) ([#800](https://github.com/go-to-k/cdkd/issues/800)) ([d3a8047](https://github.com/go-to-k/cdkd/commit/d3a804769dbd67e6e6c0f5345b2daacbca36216c))

## [0.219.2](https://github.com/go-to-k/cdkd/compare/v0.219.1...v0.219.2) (2026-06-10)


### Bug Fixes

* **provisioning:** ASG --remove-protection clears EC2 termination protection on launched instances ([#796](https://github.com/go-to-k/cdkd/issues/796)) ([#799](https://github.com/go-to-k/cdkd/issues/799)) ([7f71922](https://github.com/go-to-k/cdkd/commit/7f719220ad589aa9dac9e84dddbf987f597b9019))

## [0.219.1](https://github.com/go-to-k/cdkd/compare/v0.219.0...v0.219.1) (2026-06-10)


### Bug Fixes

* **deployment:** retry RDS create on Enhanced-Monitoring IAM-role propagation race ([#794](https://github.com/go-to-k/cdkd/issues/794)) ([#797](https://github.com/go-to-k/cdkd/issues/797)) ([6d649b6](https://github.com/go-to-k/cdkd/commit/6d649b6ad259e9fc9effc54d7ad0f221d1e3a083))

# [0.219.0](https://github.com/go-to-k/cdkd/compare/v0.218.0...v0.219.0) (2026-06-09)


### Features

* **providers:** backfill RDS DBCluster/DBInstance security properties (managed-secret + monitoring + IAM-auth) ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#795](https://github.com/go-to-k/cdkd/issues/795)) ([4c3f0d3](https://github.com/go-to-k/cdkd/commit/4c3f0d3750eb0d1a5f56f7d732b7c4f2423f0330))

# [0.218.0](https://github.com/go-to-k/cdkd/compare/v0.217.0...v0.218.0) (2026-06-09)


### Features

* **providers:** backfill EC2::Instance security properties (DisableApiTermination/MetadataOptions/Monitoring/EbsOptimized/CreditSpecification) ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#793](https://github.com/go-to-k/cdkd/issues/793)) ([b81516d](https://github.com/go-to-k/cdkd/commit/b81516d49b5720577136d07cd4879fc0c7f62ae1))

# [0.217.0](https://github.com/go-to-k/cdkd/compare/v0.216.0...v0.217.0) (2026-06-09)


### Features

* **providers:** backfill DynamoDB::Table ResourcePolicy / KinesisStreamSpecification / ContributorInsightsSpecification ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#792](https://github.com/go-to-k/cdkd/issues/792)) ([7378deb](https://github.com/go-to-k/cdkd/commit/7378deb14e2a721ced53de37e12884a1e9389029))

# [0.216.0](https://github.com/go-to-k/cdkd/compare/v0.215.0...v0.216.0) (2026-06-09)


### Features

* **providers:** backfill Cognito::UserPool 6 silent-drop properties ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#791](https://github.com/go-to-k/cdkd/issues/791)) ([64b1ccb](https://github.com/go-to-k/cdkd/commit/64b1ccb19201ff51a3a908b15d68193417023ca1))

# [0.215.0](https://github.com/go-to-k/cdkd/compare/v0.214.0...v0.215.0) (2026-06-09)


### Features

* **providers:** backfill EFS::FileSystem 6 silent-drop properties ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#790](https://github.com/go-to-k/cdkd/issues/790)) ([67a9920](https://github.com/go-to-k/cdkd/commit/67a992015c30223a26b8c4be91c70c18e8d67fd9))

# [0.214.0](https://github.com/go-to-k/cdkd/compare/v0.213.0...v0.214.0) (2026-06-08)


### Features

* **local:** invoke/run-task reach the host via host.docker.internal + start-svc/alb WARN dedup via cdk-local 0.147.0 ([#788](https://github.com/go-to-k/cdkd/issues/788)) ([04c07b6](https://github.com/go-to-k/cdkd/commit/04c07b6a9df7a4133ef97007178dcebdd16115ec))

# [0.213.0](https://github.com/go-to-k/cdkd/compare/v0.212.0...v0.213.0) (2026-06-07)


### Features

* **local:** start-cloudfront WARNs on --cache-origin without --from-cfn-stack via cdk-local 0.142.0 ([#783](https://github.com/go-to-k/cdkd/issues/783)) ([fe24a4b](https://github.com/go-to-k/cdkd/commit/fe24a4bc5c859cdd037fbbdf9419f494dca5c202))

# [0.212.0](https://github.com/go-to-k/cdkd/compare/v0.211.0...v0.212.0) (2026-06-07)


### Features

* **local:** start-cloudfront --kvs-file accepts construct path / bare id via cdk-local 0.140.0 ([#781](https://github.com/go-to-k/cdkd/issues/781)) ([1bee61c](https://github.com/go-to-k/cdkd/commit/1bee61c398b377d78642356e3b0f91daba090755))

# [0.211.0](https://github.com/go-to-k/cdkd/compare/v0.210.1...v0.211.0) (2026-06-06)


### Features

* **local:** start-agentcore warm serve + CodeConfiguration no-install via cdk-local 0.139.0 ([#774](https://github.com/go-to-k/cdkd/issues/774)-[#778](https://github.com/go-to-k/cdkd/issues/778)) ([#779](https://github.com/go-to-k/cdkd/issues/779)) ([60e1e7f](https://github.com/go-to-k/cdkd/commit/60e1e7f5232016cd9b8fbe4e9cb4b59e229dd622))

## [0.210.1](https://github.com/go-to-k/cdkd/compare/v0.210.0...v0.210.1) (2026-06-05)


### Bug Fixes

* **local:** pin ZIP Lambda --platform to declared Architectures ([#768](https://github.com/go-to-k/cdkd/issues/768)) ([#772](https://github.com/go-to-k/cdkd/issues/772)) ([e634c19](https://github.com/go-to-k/cdkd/commit/e634c1985489015726abf650c8a40324a845e517))

# [0.210.0](https://github.com/go-to-k/cdkd/compare/v0.209.1...v0.210.0) (2026-06-05)


### Features

* **local:** thread --from-state into start-cloudfront (closes [#766](https://github.com/go-to-k/cdkd/issues/766)) ([#771](https://github.com/go-to-k/cdkd/issues/771)) ([5b7b89f](https://github.com/go-to-k/cdkd/commit/5b7b89f49e38f1222dce725b9515269e74d1f13d))

## [0.209.1](https://github.com/go-to-k/cdkd/compare/v0.209.0...v0.209.1) (2026-06-05)


### Bug Fixes

* **deps:** bump cdk-local to ^0.126.6 for aws-cdk-lib 2.258.0 (schema v54) in factory pass-through local commands ([#770](https://github.com/go-to-k/cdkd/issues/770)) ([e462059](https://github.com/go-to-k/cdkd/commit/e462059b099508850cee474e9f4c0ea289bc9a16))

# [0.209.0](https://github.com/go-to-k/cdkd/compare/v0.208.0...v0.209.0) (2026-06-05)


### Features

* **local:** add start-agentcore + thread --from-state into the factory pass-throughs ([#765](https://github.com/go-to-k/cdkd/issues/765), [#766](https://github.com/go-to-k/cdkd/issues/766)) ([#767](https://github.com/go-to-k/cdkd/issues/767)) ([d5c85cb](https://github.com/go-to-k/cdkd/commit/d5c85cb3709cc9079620608957d0621b63821b9c))

# [0.208.0](https://github.com/go-to-k/cdkd/compare/v0.207.6...v0.208.0) (2026-06-03)


### Features

* **local:** inherit start-cloudfront — serve a CloudFront distribution locally ([#764](https://github.com/go-to-k/cdkd/issues/764)) ([36440dd](https://github.com/go-to-k/cdkd/commit/36440dd2f425eb5a32c1f6378433d3a591bb2d11))

## [0.207.6](https://github.com/go-to-k/cdkd/compare/v0.207.5...v0.207.6) (2026-06-02)


### Bug Fixes

* remove-protection integ failures (EPIPE crash in state list + EC2 DisableApiTermination on CC-API delete) + refresh stale schema-migration assertions ([#761](https://github.com/go-to-k/cdkd/issues/761)) ([e345ea3](https://github.com/go-to-k/cdkd/commit/e345ea3efdd063a290715dd4f8c128ec0ee79060))

## [0.207.5](https://github.com/go-to-k/cdkd/compare/v0.207.4...v0.207.5) (2026-06-02)


### Bug Fixes

* **provisioning:** handle AWS::SSM::Parameter.Tags map shape (deploy crashed on tags) ([#759](https://github.com/go-to-k/cdkd/issues/759)) ([5b2b9b0](https://github.com/go-to-k/cdkd/commit/5b2b9b0e9061265cf17495b635bf017a22ceb05b))

## [0.207.4](https://github.com/go-to-k/cdkd/compare/v0.207.3...v0.207.4) (2026-06-02)


### Bug Fixes

* **provisioning:** wait through Route53 accelerated-recovery lock transients on destroy ([#758](https://github.com/go-to-k/cdkd/issues/758)) ([f14babb](https://github.com/go-to-k/cdkd/commit/f14babb633099be5217bfcae846e881cf09e816c))

## [0.207.3](https://github.com/go-to-k/cdkd/compare/v0.207.2...v0.207.3) (2026-06-02)


### Bug Fixes

* **provisioning:** retry custom resources on transient IAM-authorization failures ([#756](https://github.com/go-to-k/cdkd/issues/756)) ([9bf64d5](https://github.com/go-to-k/cdkd/commit/9bf64d507169723e93bed7149901aa96d9156ed1))

## [0.207.2](https://github.com/go-to-k/cdkd/compare/v0.207.1...v0.207.2) (2026-06-01)


### Bug Fixes

* **destroy:** retry transient EventSourceMapping in-use delete (route destroy-runner through shared classifier) ([#752](https://github.com/go-to-k/cdkd/issues/752)) ([759f630](https://github.com/go-to-k/cdkd/commit/759f630bff4d1e7772c1974e97876b5ca31aefc4))

## [0.207.1](https://github.com/go-to-k/cdkd/compare/v0.207.0...v0.207.1) (2026-06-01)


### Bug Fixes

* **deploy:** order stacks by Fn::ImportValue/Fn::GetStackOutput in deploy/destroy --all ([#751](https://github.com/go-to-k/cdkd/issues/751)) ([5c4a7a9](https://github.com/go-to-k/cdkd/commit/5c4a7a9dfa6ef4752ddcfa69b6c3e167e510958e))

# [0.207.0](https://github.com/go-to-k/cdkd/compare/v0.206.0...v0.207.0) (2026-06-01)


### Features

* **local:** invoke-agentcore --watch (follow cdk-local [#270](https://github.com/go-to-k/cdkd/issues/270)) ([#749](https://github.com/go-to-k/cdkd/issues/749)) ([a479275](https://github.com/go-to-k/cdkd/commit/a4792755d92aa6f95724627299738217678e2b74))

# [0.206.0](https://github.com/go-to-k/cdkd/compare/v0.205.0...v0.206.0) (2026-06-01)

# [0.205.0](https://github.com/go-to-k/cdkd/compare/v0.204.0...v0.205.0) (2026-06-01)


### Features

* **local:** start-api --assume-role-auto (follow cdk-local [#271](https://github.com/go-to-k/cdkd/issues/271)) ([#747](https://github.com/go-to-k/cdkd/issues/747)) ([878578b](https://github.com/go-to-k/cdkd/commit/878578be284684cda488b008e0a5746ccc857f3f))

# [0.204.0](https://github.com/go-to-k/cdkd/compare/v0.203.0...v0.204.0) (2026-06-01)


### Features

* **local:** bump cdk-local 0.69.0 -> 0.77.1 ([#746](https://github.com/go-to-k/cdkd/issues/746)) ([df88db3](https://github.com/go-to-k/cdkd/commit/df88db358933160e7b95915c8e327b4c531b1289))

# [0.203.0](https://github.com/go-to-k/cdkd/compare/v0.202.0...v0.203.0) (2026-05-31)


### Features

* **local:** bump cdk-local to 0.69.0 (start-service --watch + Phase 4 fast path) ([#744](https://github.com/go-to-k/cdkd/issues/744)) ([7cafe8c](https://github.com/go-to-k/cdkd/commit/7cafe8cfae9003ec5ef88a37575cc898d77f139c))

# [0.202.0](https://github.com/go-to-k/cdkd/compare/v0.201.1...v0.202.0) (2026-05-31)


### Features

* **provisioning:** backfill S3Tables::TableBucket Tags ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#742](https://github.com/go-to-k/cdkd/issues/742)) ([7537cc7](https://github.com/go-to-k/cdkd/commit/7537cc769d7e1f68645be21653a5ae06dbd01abc))

## [0.201.1](https://github.com/go-to-k/cdkd/compare/v0.201.0...v0.201.1) (2026-05-31)


### Bug Fixes

* **provisioning:** tag-side AWS failures THROW instead of warn-swallow (closes [#740](https://github.com/go-to-k/cdkd/issues/740)) ([#741](https://github.com/go-to-k/cdkd/issues/741)) ([942882c](https://github.com/go-to-k/cdkd/commit/942882c6d7b347f5588f97ea7d0c150df9b2dc97))

# [0.201.0](https://github.com/go-to-k/cdkd/compare/v0.200.0...v0.201.0) (2026-05-30)


### Features

* **provisioning:** backfill S3Tables::Table Tags ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#739](https://github.com/go-to-k/cdkd/issues/739)) ([264f55f](https://github.com/go-to-k/cdkd/commit/264f55ff8dbfe2a38d225fef35a5bbc9c43c15f6))

# [0.200.0](https://github.com/go-to-k/cdkd/compare/v0.199.0...v0.200.0) (2026-05-30)


### Features

* **provisioning:** backfill RDS::DBInstance 8 props ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#738](https://github.com/go-to-k/cdkd/issues/738)) ([815b979](https://github.com/go-to-k/cdkd/commit/815b97937c2e5ce7a6df37931694e6fae7070c98))

# [0.199.0](https://github.com/go-to-k/cdkd/compare/v0.198.0...v0.199.0) (2026-05-30)


### Features

* **provisioning:** backfill Lambda::EventSourceMapping 7 props ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#735](https://github.com/go-to-k/cdkd/issues/735)) ([8ebe8f7](https://github.com/go-to-k/cdkd/commit/8ebe8f77a041fb7bad4fe5da13438524429341b6))

# [0.198.0](https://github.com/go-to-k/cdkd/compare/v0.197.0...v0.198.0) (2026-05-30)


### Features

* **provisioning:** backfill CloudFront::Distribution Tags ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#733](https://github.com/go-to-k/cdkd/issues/733)) ([78fd828](https://github.com/go-to-k/cdkd/commit/78fd8286e0ed7550844a99dee70a28fb049afadb))

# [0.197.0](https://github.com/go-to-k/cdkd/compare/v0.196.0...v0.197.0) (2026-05-30)


### Features

* **provisioning:** backfill Lambda::Function ReservedConcurrentExecutions ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#732](https://github.com/go-to-k/cdkd/issues/732)) ([f02638a](https://github.com/go-to-k/cdkd/commit/f02638a96132032af1ff81306b7e5122fec4949e))

# [0.196.0](https://github.com/go-to-k/cdkd/compare/v0.195.0...v0.196.0) (2026-05-30)


### Features

* **provisioning:** backfill S3Vectors::VectorBucket Tags ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#730](https://github.com/go-to-k/cdkd/issues/730)) ([3509921](https://github.com/go-to-k/cdkd/commit/350992101344db83c1f3ded975d2cfffe93cf566))

# [0.195.0](https://github.com/go-to-k/cdkd/compare/v0.194.0...v0.195.0) (2026-05-30)


### Features

* **local:** cdkd local start-alb — Application Load Balancer local emulator ([#725](https://github.com/go-to-k/cdkd/issues/725)) ([73afa4e](https://github.com/go-to-k/cdkd/commit/73afa4e0936ea00b68276a62a250d31ffe7497e7))

# [0.194.0](https://github.com/go-to-k/cdkd/compare/v0.193.0...v0.194.0) (2026-05-30)


### Features

* **provisioning:** backfill Route53::HostedZone HostedZoneFeatures ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#728](https://github.com/go-to-k/cdkd/issues/728)) ([1a79eaf](https://github.com/go-to-k/cdkd/commit/1a79eafa51c4a5bf5b3cca558fc5df5538d90f68))

# [0.193.0](https://github.com/go-to-k/cdkd/compare/v0.192.0...v0.193.0) (2026-05-30)


### Features

* **provisioning:** backfill ECS::Cluster ServiceConnectDefaults ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#726](https://github.com/go-to-k/cdkd/issues/726)) ([7235194](https://github.com/go-to-k/cdkd/commit/72351948a5a26b4334e2e81691a95b6adcba7cad))

# [0.192.0](https://github.com/go-to-k/cdkd/compare/v0.191.0...v0.192.0) (2026-05-30)


### Features

* **provisioning:** backfill SecretsManager::Secret Type ([#609](https://github.com/go-to-k/cdkd/issues/609)) ([#722](https://github.com/go-to-k/cdkd/issues/722)) ([a409415](https://github.com/go-to-k/cdkd/commit/a4094151448f697da546ef83b879191a2843e488))

# [0.191.0](https://github.com/go-to-k/cdkd/compare/v0.190.0...v0.191.0) (2026-05-30)


### Features

* **local-invoke-agentcore:** port cdkd local invoke-agentcore command ([#717](https://github.com/go-to-k/cdkd/issues/717)) ([7b7ae24](https://github.com/go-to-k/cdkd/commit/7b7ae24093108e076539b3112fbc187c95f7862c))

# [0.190.0](https://github.com/go-to-k/cdkd/compare/v0.189.0...v0.190.0) (2026-05-30)


### Features

* **provisioning:** backfill Events::EventBus LogConfig ([#721](https://github.com/go-to-k/cdkd/issues/721)) ([5309382](https://github.com/go-to-k/cdkd/commit/5309382e630d8a107453a6307aa97140cdbc730c))

# [0.189.0](https://github.com/go-to-k/cdkd/compare/v0.188.0...v0.189.0) (2026-05-30)


### Features

* **provisioning:** backfill ApiGateway::Authorizer AuthType ([#720](https://github.com/go-to-k/cdkd/issues/720)) ([cbc5720](https://github.com/go-to-k/cdkd/commit/cbc5720023d5a28f46f4e84792b81c636cbd3dcb))

# [0.188.0](https://github.com/go-to-k/cdkd/compare/v0.187.0...v0.188.0) (2026-05-30)


### Features

* **provisioning:** backfill Lambda::Function RecursiveLoop via post-create control-plane ([#719](https://github.com/go-to-k/cdkd/issues/719)) ([871b7ec](https://github.com/go-to-k/cdkd/commit/871b7ecdef7c3a6171585c975d48499205bfee09))

# [0.187.0](https://github.com/go-to-k/cdkd/compare/v0.186.0...v0.187.0) (2026-05-30)


### Features

* **provisioning:** backfill ApiGatewayV2::Authorizer IdentityValidationExpression ([#716](https://github.com/go-to-k/cdkd/issues/716)) ([399a276](https://github.com/go-to-k/cdkd/commit/399a276f586d111876b131a29387f0f410474d81))

# [0.186.0](https://github.com/go-to-k/cdkd/compare/v0.185.1...v0.186.0) (2026-05-30)


### Features

* **provisioning:** backfill ApiGatewayV2::Api IpAddressType ([#715](https://github.com/go-to-k/cdkd/issues/715)) ([a3be8e6](https://github.com/go-to-k/cdkd/commit/a3be8e634865de23de3b8e30e459434c2a7aff06))

## [0.185.1](https://github.com/go-to-k/cdkd/compare/v0.185.0...v0.185.1) (2026-05-30)


### Bug Fixes

* **deployment:** derive ECS Service Name from physical id ([#712](https://github.com/go-to-k/cdkd/issues/712)) ([04c51a9](https://github.com/go-to-k/cdkd/commit/04c51a9b19df0b1aa2d03d4b9263df66717794f9))

# [0.185.0](https://github.com/go-to-k/cdkd/compare/v0.184.0...v0.185.0) (2026-05-30)


### Features

* **provisioning:** backfill Lambda::Permission InvokedViaFunctionUrl + retry concurrent-update ([#711](https://github.com/go-to-k/cdkd/issues/711)) ([e9c11d2](https://github.com/go-to-k/cdkd/commit/e9c11d21991a40083974e4f125fb9d355d03a7c1))

# [0.184.0](https://github.com/go-to-k/cdkd/compare/v0.183.0...v0.184.0) (2026-05-30)


### Features

* **provisioning:** backfill ECS::TaskDefinition EnableFaultInjection ([#710](https://github.com/go-to-k/cdkd/issues/710)) ([fb6ab9d](https://github.com/go-to-k/cdkd/commit/fb6ab9da0a4228e6c058b3f26f18170e1fb6ccdd))

# [0.183.0](https://github.com/go-to-k/cdkd/compare/v0.182.0...v0.183.0) (2026-05-29)


### Features

* **provisioning:** backfill Glue::Table OpenTableFormatInput (Iceberg) ([#708](https://github.com/go-to-k/cdkd/issues/708)) ([f7f756f](https://github.com/go-to-k/cdkd/commit/f7f756fcbecc3d431ccab702bdd025e9c033855e))

# [0.182.0](https://github.com/go-to-k/cdkd/compare/v0.181.0...v0.182.0) (2026-05-29)


### Features

* **provisioning:** backfill Route53::RecordSet CidrRoutingConfig ([#707](https://github.com/go-to-k/cdkd/issues/707)) ([f4f59dc](https://github.com/go-to-k/cdkd/commit/f4f59dc8f762536ae410d192b9344d04f21b5f27))

# [0.181.0](https://github.com/go-to-k/cdkd/compare/v0.180.0...v0.181.0) (2026-05-29)


### Features

* **provisioning:** backfill Route53::RecordSet GeoProximityLocation ([#706](https://github.com/go-to-k/cdkd/issues/706)) ([c214a1e](https://github.com/go-to-k/cdkd/commit/c214a1e22fc80ae2861d80640c93289b331667ee))

# [0.180.0](https://github.com/go-to-k/cdkd/compare/v0.179.0...v0.180.0) (2026-05-29)


### Features

* **provisioning:** backfill CodeBuild::Project AutoRetryLimit ([#704](https://github.com/go-to-k/cdkd/issues/704)) ([0989361](https://github.com/go-to-k/cdkd/commit/09893610b6eb6ed375a459bd3c31e8b25bf2a6be))

# [0.179.0](https://github.com/go-to-k/cdkd/compare/v0.178.0...v0.179.0) (2026-05-29)


### Features

* **provisioning:** backfill ApiGatewayV2 Route + Authorizer config props ([#703](https://github.com/go-to-k/cdkd/issues/703)) ([06894f2](https://github.com/go-to-k/cdkd/commit/06894f253a838b383b8111a131d57d747548811d))

# [0.178.0](https://github.com/go-to-k/cdkd/compare/v0.177.0...v0.178.0) (2026-05-29)


### Features

* **provisioning:** backfill ApiGatewayV2 Api/Stage/Integration config props ([#702](https://github.com/go-to-k/cdkd/issues/702)) ([bcd0a8d](https://github.com/go-to-k/cdkd/commit/bcd0a8db87b993e0ed565d44c4b2391cb15d7307))

# [0.177.0](https://github.com/go-to-k/cdkd/compare/v0.176.0...v0.177.0) (2026-05-29)


### Features

* **provisioning:** backfill DynamoDB::Table WarmThroughput ([#701](https://github.com/go-to-k/cdkd/issues/701)) ([6e11981](https://github.com/go-to-k/cdkd/commit/6e1198132a03f300764dfafd67f665c0b7aa9c6e))

# [0.176.0](https://github.com/go-to-k/cdkd/compare/v0.175.0...v0.176.0) (2026-05-29)


### Features

* **provisioning:** backfill ApiGateway::Stage TracingEnabled + Variables ([#700](https://github.com/go-to-k/cdkd/issues/700)) ([e31c004](https://github.com/go-to-k/cdkd/commit/e31c004397724032a1505151d728ee2e62d83a3c))

# [0.175.0](https://github.com/go-to-k/cdkd/compare/v0.174.0...v0.175.0) (2026-05-29)


### Features

* **provisioning:** backfill DynamoDB::Table OnDemandThroughput ([#699](https://github.com/go-to-k/cdkd/issues/699)) ([56e13f3](https://github.com/go-to-k/cdkd/commit/56e13f327652ef72cdc26ff52ad50961c8689bf6))

# [0.174.0](https://github.com/go-to-k/cdkd/compare/v0.173.0...v0.174.0) (2026-05-29)


### Features

* **provisioning:** backfill SQS + SNS Subscription messaging attrs ([#698](https://github.com/go-to-k/cdkd/issues/698)) ([9f8b919](https://github.com/go-to-k/cdkd/commit/9f8b919bd7e006af8b47e3841163993861ab480c))

# [0.173.0](https://github.com/go-to-k/cdkd/compare/v0.172.0...v0.173.0) (2026-05-29)


### Features

* **provisioning:** backfill Lambda::Function LoggingConfig ([#697](https://github.com/go-to-k/cdkd/issues/697)) ([6c131a1](https://github.com/go-to-k/cdkd/commit/6c131a11f42a59484017154669b7e03ee11468cf))

# [0.172.0](https://github.com/go-to-k/cdkd/compare/v0.171.0...v0.172.0) (2026-05-29)


### Features

* **provisioning:** backfill DynamoDB::Table PITR + TTL specs ([#696](https://github.com/go-to-k/cdkd/issues/696)) ([15018f2](https://github.com/go-to-k/cdkd/commit/15018f2026ebe1356e6a5a032b3d3121a09e832c))

# [0.171.0](https://github.com/go-to-k/cdkd/compare/v0.170.0...v0.171.0) (2026-05-29)


### Features

* **provisioning:** backfill 4 CloudWatch::Alarm config props ([#695](https://github.com/go-to-k/cdkd/issues/695)) ([3d43ada](https://github.com/go-to-k/cdkd/commit/3d43adadc4c06e0a959d8f1a86db3730ca89a371))

# [0.170.0](https://github.com/go-to-k/cdkd/compare/v0.169.1...v0.170.0) (2026-05-29)


### Features

* **provisioning:** backfill 5 native Lambda::Function config props ([#694](https://github.com/go-to-k/cdkd/issues/694)) ([b5a50e1](https://github.com/go-to-k/cdkd/commit/b5a50e13c8c15d5f6228ab7236e1393b02f39234))

## [0.169.1](https://github.com/go-to-k/cdkd/compare/v0.169.0...v0.169.1) (2026-05-28)


### Bug Fixes

* **local:** set cdk-local embedConfig so shimmed modules render cdkd branding ([#685](https://github.com/go-to-k/cdkd/issues/685)) ([50953b8](https://github.com/go-to-k/cdkd/commit/50953b8bf1e92db0db4b14e3737e109e58ad4104))

# [0.169.0](https://github.com/go-to-k/cdkd/compare/v0.168.0...v0.169.0) (2026-05-27)


### Features

* **local:** mirror cdk-local start-api UX (env-vars display path + multi-stack --from-cfn-stack inference + bare-form docs) ([#676](https://github.com/go-to-k/cdkd/issues/676)) ([4d4513e](https://github.com/go-to-k/cdkd/commit/4d4513e3e09352dfb23e2f4037db443a5748ef3a))

# [0.168.0](https://github.com/go-to-k/cdkd/compare/v0.167.3...v0.168.0) (2026-05-27)


### Features

* **state:** schema v8 + Fn::GetStackOutput consumer enumeration ([#671](https://github.com/go-to-k/cdkd/issues/671)) ([21b1f1c](https://github.com/go-to-k/cdkd/commit/21b1f1c343a54f44e704435cd851aece55d5e62a))

## [0.167.3](https://github.com/go-to-k/cdkd/compare/v0.167.2...v0.167.3) (2026-05-27)


### Bug Fixes

* **local:** mount profile-aware credentials file for ECS containers (fromIni({ profile }) handlers) ([#672](https://github.com/go-to-k/cdkd/issues/672)) ([c47ac79](https://github.com/go-to-k/cdkd/commit/c47ac79a2f1054227216948401ce791330050846))

## [0.167.2](https://github.com/go-to-k/cdkd/compare/v0.167.1...v0.167.2) (2026-05-27)


### Bug Fixes

* **local:** mount profile-aware credentials file for fromIni({ profile }) handlers ([#670](https://github.com/go-to-k/cdkd/issues/670)) ([55440d3](https://github.com/go-to-k/cdkd/commit/55440d3a57172fe0ce3b32f048542aaf47361c4a))

## [0.167.1](https://github.com/go-to-k/cdkd/compare/v0.167.0...v0.167.1) (2026-05-27)


### Bug Fixes

* **local:** synthesize default prelude when RIE streaming response lacks separator ([#664](https://github.com/go-to-k/cdkd/issues/664)) ([#667](https://github.com/go-to-k/cdkd/issues/667)) ([988e5b7](https://github.com/go-to-k/cdkd/commit/988e5b77f1c7fed6326987d3514ca67e0b87cf6b))

# [0.167.0](https://github.com/go-to-k/cdkd/compare/v0.166.1...v0.167.0) (2026-05-27)


### Features

* **deploy:** symmetric blockedAlreadyCcApi refusal for --recreate-via-cc-api ([#666](https://github.com/go-to-k/cdkd/issues/666)) ([99b1fe7](https://github.com/go-to-k/cdkd/commit/99b1fe74209b79d68d11e4ab829712cd85daecad))

## [0.166.1](https://github.com/go-to-k/cdkd/compare/v0.166.0...v0.166.1) (2026-05-27)


### Bug Fixes

* **local:** forward --profile-resolved credentials to ECS metadata sidecar ([#658](https://github.com/go-to-k/cdkd/issues/658)) ([#662](https://github.com/go-to-k/cdkd/issues/662)) ([68b3c1e](https://github.com/go-to-k/cdkd/commit/68b3c1ef38c57b268e4122cb60d2e954af847e8c))

# [0.166.0](https://github.com/go-to-k/cdkd/compare/v0.165.0...v0.166.0) (2026-05-27)


### Features

* **deploy:** --recreate-via-sdk-provider for reverse CC->SDK migration ([#663](https://github.com/go-to-k/cdkd/issues/663)) ([4bbf357](https://github.com/go-to-k/cdkd/commit/4bbf357501095fcc73fe51b8db5fc1031b084761))

# [0.165.0](https://github.com/go-to-k/cdkd/compare/v0.164.1...v0.165.0) (2026-05-27)


### Features

* **deploy:** enumerate downstream Fn::ImportValue consumers in --recreate-via-cc-api warn ([#660](https://github.com/go-to-k/cdkd/issues/660)) ([f4532ed](https://github.com/go-to-k/cdkd/commit/f4532edd4d66142764647894020bae4dc6cb56e5))

## [0.164.1](https://github.com/go-to-k/cdkd/compare/v0.164.0...v0.164.1) (2026-05-27)


### Bug Fixes

* **local:** forward --profile-resolved credentials to local-invoke Lambda container ([#657](https://github.com/go-to-k/cdkd/issues/657)) ([#661](https://github.com/go-to-k/cdkd/issues/661)) ([fd98abc](https://github.com/go-to-k/cdkd/commit/fd98abcc23f1dde3296553d126e43280354df2c1))

# [0.164.0](https://github.com/go-to-k/cdkd/compare/v0.163.0...v0.164.0) (2026-05-27)


### Features

* **deploy:** interactive [y/N] prompt for --recreate-via-cc-api ([#659](https://github.com/go-to-k/cdkd/issues/659)) ([85a77f4](https://github.com/go-to-k/cdkd/commit/85a77f4027b739052b7680a39a647a0e1c5d34f7))

# [0.163.0](https://github.com/go-to-k/cdkd/compare/v0.162.3...v0.163.0) (2026-05-27)


### Features

* **deploy:** live s3:ListObjectsV2 probe for --recreate-via-cc-api stateful guard ([#656](https://github.com/go-to-k/cdkd/issues/656)) ([bd4c85e](https://github.com/go-to-k/cdkd/commit/bd4c85e01b990dedf86150aa43aabddb33db0b91))

## [0.162.3](https://github.com/go-to-k/cdkd/compare/v0.162.2...v0.162.3) (2026-05-27)


### Bug Fixes

* **local:** forward --profile-resolved credentials to Lambda container ([#654](https://github.com/go-to-k/cdkd/issues/654)) ([#655](https://github.com/go-to-k/cdkd/issues/655)) ([3456bcb](https://github.com/go-to-k/cdkd/commit/3456bcbc3f6f88cdd278a70c3630c0f9709e2ba8))

## [0.162.2](https://github.com/go-to-k/cdkd/compare/v0.162.1...v0.162.2) (2026-05-27)


### Bug Fixes

* **local:** set CORS headers on actual responses, not just preflight ([#652](https://github.com/go-to-k/cdkd/issues/652)) ([#653](https://github.com/go-to-k/cdkd/issues/653)) ([84b2652](https://github.com/go-to-k/cdkd/commit/84b26522fc32e3882d71375bef24f98faa017b81))

## [0.162.1](https://github.com/go-to-k/cdkd/compare/v0.162.0...v0.162.1) (2026-05-27)


### Bug Fixes

* **local:** borrow CloudFront ResponseHeadersPolicy CORS for fronted Function URLs ([#646](https://github.com/go-to-k/cdkd/issues/646)) ([#647](https://github.com/go-to-k/cdkd/issues/647)) ([284b9cf](https://github.com/go-to-k/cdkd/commit/284b9cfabd1234bc8f8e1663ec2b0fee1b1f13ed))

# [0.162.0](https://github.com/go-to-k/cdkd/compare/v0.161.4...v0.162.0) (2026-05-27)


### Features

* **provisioning:** --recreate-via-cc-api for mid-life SDK→CC migration ([#615](https://github.com/go-to-k/cdkd/issues/615)) ([#643](https://github.com/go-to-k/cdkd/issues/643)) ([1143126](https://github.com/go-to-k/cdkd/commit/1143126e6d4bc2ac6e9d1bf815eef805080ee139))

## [0.161.4](https://github.com/go-to-k/cdkd/compare/v0.161.3...v0.161.4) (2026-05-27)


### Bug Fixes

* **local:** honor AWS::Lambda::Url.Cors block in start-api preflight ([#644](https://github.com/go-to-k/cdkd/issues/644)) ([#645](https://github.com/go-to-k/cdkd/issues/645)) ([ab168e8](https://github.com/go-to-k/cdkd/commit/ab168e84da691ff77381ca20e1805ea9ae3b6cff))

## [0.161.3](https://github.com/go-to-k/cdkd/compare/v0.161.2...v0.161.3) (2026-05-27)


### Bug Fixes

* **local:** use absolute GitHub URLs in user-facing docs references ([#641](https://github.com/go-to-k/cdkd/issues/641)) ([#642](https://github.com/go-to-k/cdkd/issues/642)) ([ff2e5bb](https://github.com/go-to-k/cdkd/commit/ff2e5bb973fb02973a29c9ebb4f753ef91deaff8))

## [0.161.2](https://github.com/go-to-k/cdkd/compare/v0.161.1...v0.161.2) (2026-05-27)


### Bug Fixes

* **local:** resolve Fn::Select + Fn::Split in --from-state env vars ([#636](https://github.com/go-to-k/cdkd/issues/636)) ([#640](https://github.com/go-to-k/cdkd/issues/640)) ([7ad2011](https://github.com/go-to-k/cdkd/commit/7ad201130de38eab31a62f0c32fb97adcf004831))

## [0.161.1](https://github.com/go-to-k/cdkd/compare/v0.161.0...v0.161.1) (2026-05-27)


### Bug Fixes

* **local:** resolve canonical fromImageAsset image URI ([#637](https://github.com/go-to-k/cdkd/issues/637)) ([#639](https://github.com/go-to-k/cdkd/issues/639)) ([e49ccca](https://github.com/go-to-k/cdkd/commit/e49cccab98d8157a3ae0c328d98dc2bd1842f03a))

# [0.161.0](https://github.com/go-to-k/cdkd/compare/v0.160.0...v0.161.0) (2026-05-27)


### Features

* **diff:** wire [#614](https://github.com/go-to-k/cdkd/issues/614) routing annotation into cdkd diff + deploy live-progress ([#635](https://github.com/go-to-k/cdkd/issues/635)) ([86dd741](https://github.com/go-to-k/cdkd/commit/86dd741cd4e65aa0d48e9e682c53cf6b10a9c2b1))

# [0.160.0](https://github.com/go-to-k/cdkd/compare/v0.159.3...v0.160.0) (2026-05-26)


### Features

* **provisioning:** Cloud Control API auto-fallback for silent-drop properties ([#633](https://github.com/go-to-k/cdkd/issues/633)) ([e06313d](https://github.com/go-to-k/cdkd/commit/e06313da8fa595c9835760d927e545cd5bce6147))

## [0.159.3](https://github.com/go-to-k/cdkd/compare/v0.159.2...v0.159.3) (2026-05-26)


### Bug Fixes

* **local:** recognize Fn::Join Code.ImageUri in start-api ([#627](https://github.com/go-to-k/cdkd/issues/627)) ([#632](https://github.com/go-to-k/cdkd/issues/632)) ([9e8158f](https://github.com/go-to-k/cdkd/commit/9e8158f3c20addab640d722bf3519fe0032e72ac))

## [0.159.2](https://github.com/go-to-k/cdkd/compare/v0.159.1...v0.159.2) (2026-05-26)


### Bug Fixes

* **local:** honor --profile for --from-cfn-stack CFn client ([#628](https://github.com/go-to-k/cdkd/issues/628)) ([#631](https://github.com/go-to-k/cdkd/issues/631)) ([817e7fe](https://github.com/go-to-k/cdkd/commit/817e7fe9e206c30fd90d91c2a74776578942266a))

## [0.159.1](https://github.com/go-to-k/cdkd/compare/v0.159.0...v0.159.1) (2026-05-26)


### Bug Fixes

* **local:** return 403 for REST v1 AWS_IAM rejection ([#625](https://github.com/go-to-k/cdkd/issues/625)) ([#630](https://github.com/go-to-k/cdkd/issues/630)) ([5ab51cf](https://github.com/go-to-k/cdkd/commit/5ab51cf2d5d4b484e2ad7eecb28d5e6a54067fd8))

# [0.159.0](https://github.com/go-to-k/cdkd/compare/v0.158.1...v0.159.0) (2026-05-26)


### Features

* **local:** support Function URL AuthType: AWS_IAM via existing SigV4 verifier ([#624](https://github.com/go-to-k/cdkd/issues/624)) ([3f80a97](https://github.com/go-to-k/cdkd/commit/3f80a978d6464c446fadd907bebd8b43140371b0))

## [0.158.1](https://github.com/go-to-k/cdkd/compare/v0.158.0...v0.158.1) (2026-05-26)


### Bug Fixes

* **provisioning:** wire silent-drop property aliases + declare design-intentional non-support ([#623](https://github.com/go-to-k/cdkd/issues/623)) ([2f25e87](https://github.com/go-to-k/cdkd/commit/2f25e87e7b9a126827c8ac7d97e76d3686874b75))

# [0.158.0](https://github.com/go-to-k/cdkd/compare/v0.157.0...v0.158.0) (2026-05-26)


### Features

* **local:** --from-cfn-stack for CloudFormation-deployed CDK apps ([#610](https://github.com/go-to-k/cdkd/issues/610)) ([d83cb6e](https://github.com/go-to-k/cdkd/commit/d83cb6eee7a9bc2c6f7923b58e9a8cbdb20de9ac))

# [0.157.0](https://github.com/go-to-k/cdkd/compare/v0.156.0...v0.157.0) (2026-05-26)


### Features

* **provisioning:** add ACMCertificateProvider (AWS::CertificateManager::Certificate) ([#607](https://github.com/go-to-k/cdkd/issues/607)) ([17b2864](https://github.com/go-to-k/cdkd/commit/17b2864f562676f71b437fd8dedd91c9266063fa))

# [0.156.0](https://github.com/go-to-k/cdkd/compare/v0.155.0...v0.156.0) (2026-05-26)


### Features

* **provisioning:** fail fast on silent-drop properties at pre-flight ([#608](https://github.com/go-to-k/cdkd/issues/608)) ([aa7547f](https://github.com/go-to-k/cdkd/commit/aa7547fe49c5335bcf4340ea91eace62f792cc84))

# [0.155.0](https://github.com/go-to-k/cdkd/compare/v0.154.0...v0.155.0) (2026-05-26)


### Features

* **provisioning:** add IAMManagedPolicyProvider (AWS::IAM::ManagedPolicy) ([#605](https://github.com/go-to-k/cdkd/issues/605)) ([c2912f3](https://github.com/go-to-k/cdkd/commit/c2912f36f58b8d306d346a61ff0ee9b7e6ef434e))

# [0.154.0](https://github.com/go-to-k/cdkd/compare/v0.153.0...v0.154.0) (2026-05-26)


### Features

* **provisioning:** fail fast on NON_PROVISIONABLE (tier3) resource types at pre-flight ([#603](https://github.com/go-to-k/cdkd/issues/603)) ([39e72c3](https://github.com/go-to-k/cdkd/commit/39e72c3e804464f73ecd950646008e06465d8b04))

# [0.153.0](https://github.com/go-to-k/cdkd/compare/v0.152.2...v0.153.0) (2026-05-26)


### Features

* **deployment:** hard-error on unknown CloudFormation intrinsics instead of silent pass-through ([#604](https://github.com/go-to-k/cdkd/issues/604)) ([df8a979](https://github.com/go-to-k/cdkd/commit/df8a9799f91c2a1e17b042c1d4de8c197a8ece4e))

## [0.152.2](https://github.com/go-to-k/cdkd/compare/v0.152.1...v0.152.2) (2026-05-25)


### Bug Fixes

* **destroy:** show a check for deleted resources instead of a cross (and align deploy's updated glyph) ([#601](https://github.com/go-to-k/cdkd/issues/601)) ([8d56690](https://github.com/go-to-k/cdkd/commit/8d566907c5ddfe62790405f950b8be0ea5228d15))

## [0.152.1](https://github.com/go-to-k/cdkd/compare/v0.152.0...v0.152.1) (2026-05-25)


### Bug Fixes

* **deploy:** stop DagBuilder warning on a Ref to a template Parameter ([#600](https://github.com/go-to-k/cdkd/issues/600)) ([3ec8982](https://github.com/go-to-k/cdkd/commit/3ec89820950970f92266434197376626e316775b))

# [0.152.0](https://github.com/go-to-k/cdkd/compare/v0.151.1...v0.152.0) (2026-05-25)


### Features

* **export:** resolve intrinsic child Parameters at leaf-IMPORT time ([#464](https://github.com/go-to-k/cdkd/issues/464)) ([#599](https://github.com/go-to-k/cdkd/issues/599)) ([28fa364](https://github.com/go-to-k/cdkd/commit/28fa3641cdcb5e858ddc2c6e239f56148d5b0628))

## [0.151.1](https://github.com/go-to-k/cdkd/compare/v0.151.0...v0.151.1) (2026-05-25)


### Bug Fixes

* **diff:** close PR [#595](https://github.com/go-to-k/cdkd/issues/595) review nits (--json/--verbose + asset-path guard) ([#598](https://github.com/go-to-k/cdkd/issues/598)) ([02fa8af](https://github.com/go-to-k/cdkd/commit/02fa8af7cae7483ff062d347c9783b5ff601e65b))

# [0.151.0](https://github.com/go-to-k/cdkd/compare/v0.150.2...v0.151.0) (2026-05-25)


### Features

* **diff:** recursive nested-stack child diff ([#555](https://github.com/go-to-k/cdkd/issues/555) A5) ([#595](https://github.com/go-to-k/cdkd/issues/595)) ([dc767a5](https://github.com/go-to-k/cdkd/commit/dc767a5cb36bdfa6812f333a0e0393ff48d48695))

## [0.150.2](https://github.com/go-to-k/cdkd/compare/v0.150.1...v0.150.2) (2026-05-25)


### Bug Fixes

* **export:** nested-stack IMPORT-loop review-residual cleanup ([#589](https://github.com/go-to-k/cdkd/issues/589)) ([#592](https://github.com/go-to-k/cdkd/issues/592)) ([cbb2539](https://github.com/go-to-k/cdkd/commit/cbb25392d0b21d4ae863a48e4cd2ba474634e031))

## [0.150.1](https://github.com/go-to-k/cdkd/compare/v0.150.0...v0.150.1) (2026-05-25)


### Bug Fixes

* **local:** skip host-port publish for multi-replica services ([#590](https://github.com/go-to-k/cdkd/issues/590)) ([23e966d](https://github.com/go-to-k/cdkd/commit/23e966d0f1fd2a24362852434cb31aaf2b000ed9))

# [0.150.0](https://github.com/go-to-k/cdkd/compare/v0.149.0...v0.150.0) (2026-05-24)


### Features

* **export:** per-stack IMPORT loop for nested-stack trees ([#464](https://github.com/go-to-k/cdkd/issues/464) PR B2) ([#588](https://github.com/go-to-k/cdkd/issues/588)) ([d02cde8](https://github.com/go-to-k/cdkd/commit/d02cde8926f2f899d5da2ddfb67937ca3cb79397))

# [0.149.0](https://github.com/go-to-k/cdkd/compare/v0.148.0...v0.149.0) (2026-05-24)


### Features

* **state-show:** --show-nested recursively prints nested-stack children ([#555](https://github.com/go-to-k/cdkd/issues/555) A4) ([#586](https://github.com/go-to-k/cdkd/issues/586)) ([34b52a6](https://github.com/go-to-k/cdkd/commit/34b52a61e63130bdfc9a588a30f9cb9c91633a3b))

# [0.148.0](https://github.com/go-to-k/cdkd/compare/v0.147.2...v0.148.0) (2026-05-24)


### Features

* **state-list:** parent -> child tree rendering ([#555](https://github.com/go-to-k/cdkd/issues/555) A3) ([#580](https://github.com/go-to-k/cdkd/issues/580)) ([a64d5db](https://github.com/go-to-k/cdkd/commit/a64d5dbbdd22c0b9f7e9c54aae6d74c37af8bebd))

## [0.147.2](https://github.com/go-to-k/cdkd/compare/v0.147.1...v0.147.2) (2026-05-24)


### Bug Fixes

* **local:** close Service Connect / Cloud Map review nits ([#577](https://github.com/go-to-k/cdkd/issues/577)) ([1e97aea](https://github.com/go-to-k/cdkd/commit/1e97aea677da26c150f104f3b1c55a20966300cf))

## [0.147.1](https://github.com/go-to-k/cdkd/compare/v0.147.0...v0.147.1) (2026-05-24)


### Bug Fixes

* **destroy:** refuse cdkd destroy on nested-stack children ([#555](https://github.com/go-to-k/cdkd/issues/555) A2) ([#572](https://github.com/go-to-k/cdkd/issues/572)) ([b1ccc36](https://github.com/go-to-k/cdkd/commit/b1ccc366414eaccb90e6060e15d2005b77b613b0))

# [0.147.0](https://github.com/go-to-k/cdkd/compare/v0.146.1...v0.147.0) (2026-05-24)


### Features

* **export:** recursive nested-stack tree walker ([#464](https://github.com/go-to-k/cdkd/issues/464) PR B1) ([#571](https://github.com/go-to-k/cdkd/issues/571)) ([a58618b](https://github.com/go-to-k/cdkd/commit/a58618bf33584347167aea7226e853e37471f332))

## [0.146.1](https://github.com/go-to-k/cdkd/compare/v0.146.0...v0.146.1) (2026-05-24)


### Bug Fixes

* **nested-stack:** cross-platform absolute-path check in indexGrandchildTemplates ([#570](https://github.com/go-to-k/cdkd/issues/570)) ([a0a1c4a](https://github.com/go-to-k/cdkd/commit/a0a1c4aee95960f020661bc46b130279cc510506))

# [0.146.0](https://github.com/go-to-k/cdkd/compare/v0.145.1...v0.146.0) (2026-05-24)


### Features

* **import:** recursive nested-stack support for --migrate-from-cloudformation ([#464](https://github.com/go-to-k/cdkd/issues/464) PR A) ([#564](https://github.com/go-to-k/cdkd/issues/564)) ([b281165](https://github.com/go-to-k/cdkd/commit/b281165b8a68e5bbfecee68ecc7998abf7cbdf46))

## [0.145.1](https://github.com/go-to-k/cdkd/compare/v0.145.0...v0.145.1) (2026-05-24)


### Bug Fixes

* **hooks:** make markgate gate hooks cwd-aware ([#559](https://github.com/go-to-k/cdkd/issues/559)) ([#562](https://github.com/go-to-k/cdkd/issues/562)) ([9fd262f](https://github.com/go-to-k/cdkd/commit/9fd262f8445b479b7b7e6af386f552733b010098))

# [0.145.0](https://github.com/go-to-k/cdkd/compare/v0.144.0...v0.145.0) (2026-05-23)


### Features

* **provisioning:** in-place update for all 7 Firehose destination types ([#549](https://github.com/go-to-k/cdkd/issues/549) bundle) ([#553](https://github.com/go-to-k/cdkd/issues/553)) ([62bf587](https://github.com/go-to-k/cdkd/commit/62bf58729104a119f600b1d7e95938874262f085))

# [0.144.0](https://github.com/go-to-k/cdkd/compare/v0.143.0...v0.144.0) (2026-05-23)


### Features

* **provisioning:** AWS::CloudFormation::Stack nested stack support ([#459](https://github.com/go-to-k/cdkd/issues/459) main) ([#548](https://github.com/go-to-k/cdkd/issues/548)) ([c1abf52](https://github.com/go-to-k/cdkd/commit/c1abf52e893f91c87cf44234c4fa0aa4427e9990))

# [0.143.0](https://github.com/go-to-k/cdkd/compare/v0.142.0...v0.143.0) (2026-05-23)


### Features

* **hooks:** main-tree-branch-gate prevents cross-agent main-tree contention ([#554](https://github.com/go-to-k/cdkd/issues/554)) ([c275a31](https://github.com/go-to-k/cdkd/commit/c275a319f355af70e1b637406e4a9091ddc656c1))

# [0.142.0](https://github.com/go-to-k/cdkd/compare/v0.141.1...v0.142.0) (2026-05-23)


### Features

* **provisioning:** in-place update for Firehose RedshiftDestinationConfiguration ([#550](https://github.com/go-to-k/cdkd/issues/550)) ([4a8e7e9](https://github.com/go-to-k/cdkd/commit/4a8e7e9383a640dfc84e05e5a7fb4f1e39546eb5))

## [0.141.1](https://github.com/go-to-k/cdkd/compare/v0.141.0...v0.141.1) (2026-05-23)


### Bug Fixes

* **asg-provider:** drift-revert round-trip for ASG Tags/LB/TG + fixture coverage ([#547](https://github.com/go-to-k/cdkd/issues/547)) ([49c91d7](https://github.com/go-to-k/cdkd/commit/49c91d7baf758edf6e546766dae14816caa3b659))

# [0.141.0](https://github.com/go-to-k/cdkd/compare/v0.140.0...v0.141.0) (2026-05-23)


### Features

* **state:** schema v6 prep — parentStack/parentLogicalId/parentRegion ([#459](https://github.com/go-to-k/cdkd/issues/459)) ([#546](https://github.com/go-to-k/cdkd/issues/546)) ([c62bad5](https://github.com/go-to-k/cdkd/commit/c62bad54dfd0eca401b51c78a8c933a4c6c9cbf2))

# [0.140.0](https://github.com/go-to-k/cdkd/compare/v0.139.0...v0.140.0) (2026-05-23)


### Features

* **provisioning:** in-place update for Firehose ExtendedS3 destination + Tags ([#477](https://github.com/go-to-k/cdkd/issues/477)) ([#545](https://github.com/go-to-k/cdkd/issues/545)) ([7cb1192](https://github.com/go-to-k/cdkd/commit/7cb119245019bd8302596dbad6b3e283fc277b58))

# [0.139.0](https://github.com/go-to-k/cdkd/compare/v0.138.0...v0.139.0) (2026-05-23)


### Features

* **local:** ECS Service Connect + Cloud Map local emulation ([#460](https://github.com/go-to-k/cdkd/issues/460)) ([#522](https://github.com/go-to-k/cdkd/issues/522)) ([b432b4f](https://github.com/go-to-k/cdkd/commit/b432b4f153d3736ae07c505eb81ffa4bf95689aa))

# [0.138.0](https://github.com/go-to-k/cdkd/compare/v0.137.3...v0.138.0) (2026-05-23)


### Features

* **provisioning:** in-place update for ASG Tags + LoadBalancerNames + TargetGroupARNs ([#475](https://github.com/go-to-k/cdkd/issues/475), [#476](https://github.com/go-to-k/cdkd/issues/476)) ([#543](https://github.com/go-to-k/cdkd/issues/543)) ([6043a79](https://github.com/go-to-k/cdkd/commit/6043a79df4fbae9fe52e7a4f949e0e8a162f1593))

## [0.137.3](https://github.com/go-to-k/cdkd/compare/v0.137.2...v0.137.3) (2026-05-23)


### Bug Fixes

* **local:** WebSocket [#531](https://github.com/go-to-k/cdkd/issues/531) MINORs — accountId / apiCdkPath / test gaps ([#541](https://github.com/go-to-k/cdkd/issues/541)) ([1fd1e35](https://github.com/go-to-k/cdkd/commit/1fd1e35bb873ebcf6ce8b1274cd47d70be5ec172))

## [0.137.2](https://github.com/go-to-k/cdkd/compare/v0.137.1...v0.137.2) (2026-05-23)


### Bug Fixes

* **local:** WebSocket robustness MAJORs ([#527](https://github.com/go-to-k/cdkd/issues/527)) ([#539](https://github.com/go-to-k/cdkd/issues/539)) ([b98ac8f](https://github.com/go-to-k/cdkd/commit/b98ac8f8c0ec4bba5f8e46f23f075286e4006a37))

## [0.137.1](https://github.com/go-to-k/cdkd/compare/v0.137.0...v0.137.1) (2026-05-23)


### Bug Fixes

* **local:** post-[#524](https://github.com/go-to-k/cdkd/issues/524) WebSocket audit follow-ups ([#538](https://github.com/go-to-k/cdkd/issues/538)) ([75da9a6](https://github.com/go-to-k/cdkd/commit/75da9a636622481d4382101f2a1917ad719ca258))

# [0.137.0](https://github.com/go-to-k/cdkd/compare/v0.136.0...v0.137.0) (2026-05-23)


### Features

* **local:** WebSocket API support for cdkd local start-api ([#462](https://github.com/go-to-k/cdkd/issues/462)) ([#524](https://github.com/go-to-k/cdkd/issues/524)) ([3ff7413](https://github.com/go-to-k/cdkd/commit/3ff7413c84bfe5254e700b5cc05546bcb67bee63))

# [0.136.0](https://github.com/go-to-k/cdkd/compare/v0.135.1...v0.136.0) (2026-05-22)


### Features

* **synthesis:** CloudFormation macro support via CFn round-trip ([#463](https://github.com/go-to-k/cdkd/issues/463)) ([#519](https://github.com/go-to-k/cdkd/issues/519)) ([2c8ac78](https://github.com/go-to-k/cdkd/commit/2c8ac78968859b6844ef38007043d79ffb46b06d))

## [0.135.1](https://github.com/go-to-k/cdkd/compare/v0.135.0...v0.135.1) (2026-05-22)


### Bug Fixes

* **local:** bundle review nits from 2026-05-22 cleanup session ([#515](https://github.com/go-to-k/cdkd/issues/515)) ([#518](https://github.com/go-to-k/cdkd/issues/518)) ([d931cca](https://github.com/go-to-k/cdkd/commit/d931cca71adcb17e74d93f697ebe4515a9bff150))

# [0.135.0](https://github.com/go-to-k/cdkd/compare/v0.134.0...v0.135.0) (2026-05-22)


### Features

* **migrate:** PR B CLI + 2-pass resource mapping + import + retire ([#465](https://github.com/go-to-k/cdkd/issues/465)) ([#517](https://github.com/go-to-k/cdkd/issues/517)) ([ae19dc6](https://github.com/go-to-k/cdkd/commit/ae19dc696047b430d2ec1a2e418643aa5a329186))

# [0.134.0](https://github.com/go-to-k/cdkd/compare/v0.133.0...v0.134.0) (2026-05-22)


### Features

* **migrate:** PR A library (spawn + codegen + synth, no CLI register) ([#465](https://github.com/go-to-k/cdkd/issues/465)) ([#513](https://github.com/go-to-k/cdkd/issues/513)) ([2431ca6](https://github.com/go-to-k/cdkd/commit/2431ca6d296cb461f0b26023fda4e8fd261ebc76))

# [0.133.0](https://github.com/go-to-k/cdkd/compare/v0.132.4...v0.133.0) (2026-05-22)


### Features

* **local-start-api:** authorizer pass on service-integration routes ([#502](https://github.com/go-to-k/cdkd/issues/502)) ([#514](https://github.com/go-to-k/cdkd/issues/514)) ([bef5b7f](https://github.com/go-to-k/cdkd/commit/bef5b7fef00ca8c0b1e66d6bb954ea08da70ed80))

## [0.132.4](https://github.com/go-to-k/cdkd/compare/v0.132.3...v0.132.4) (2026-05-22)


### Bug Fixes

* **local-start-api:** REST v1 non-AWS_PROXY follow-ups ([#507](https://github.com/go-to-k/cdkd/issues/507)) ([#511](https://github.com/go-to-k/cdkd/issues/511)) ([b9230f6](https://github.com/go-to-k/cdkd/commit/b9230f60befc8a2ed642f0e4004f28d2264c3f96))

## [0.132.3](https://github.com/go-to-k/cdkd/compare/v0.132.2...v0.132.3) (2026-05-22)


### Bug Fixes

* **local-start-api:** RESPONSE_STREAM hardening ([#503](https://github.com/go-to-k/cdkd/issues/503)) ([#510](https://github.com/go-to-k/cdkd/issues/510)) ([3574353](https://github.com/go-to-k/cdkd/commit/3574353fed76c2f3e9b4516d5dedfded29014691))

## [0.132.2](https://github.com/go-to-k/cdkd/compare/v0.132.1...v0.132.2) (2026-05-22)


### Bug Fixes

* **local-start-service:** PR [#504](https://github.com/go-to-k/cdkd/issues/504) review follow-ups ([#506](https://github.com/go-to-k/cdkd/issues/506)) ([#509](https://github.com/go-to-k/cdkd/issues/509)) ([b8da7d8](https://github.com/go-to-k/cdkd/commit/b8da7d8bf11fada28aff2b57881220753d17b85f))

## [0.132.1](https://github.com/go-to-k/cdkd/compare/v0.132.0...v0.132.1) (2026-05-22)


### Bug Fixes

* **hooks:** pr-review-gate parses PR number from the LAST 'gh pr merge' ([#508](https://github.com/go-to-k/cdkd/issues/508)) ([8de2b70](https://github.com/go-to-k/cdkd/commit/8de2b70e5b3f6f3e320f6c74bc3c63ffd3aae5f5))

# [0.132.0](https://github.com/go-to-k/cdkd/compare/v0.131.0...v0.132.0) (2026-05-22)


### Features

* **local-start-api:** REST v1 non-AWS_PROXY integrations ([#457](https://github.com/go-to-k/cdkd/issues/457)) ([#505](https://github.com/go-to-k/cdkd/issues/505)) ([de67bf2](https://github.com/go-to-k/cdkd/commit/de67bf2662b79bbe7c4767b7b0dab5248a8f0725))

# [0.131.0](https://github.com/go-to-k/cdkd/compare/v0.130.0...v0.131.0) (2026-05-22)


### Features

* **local:** cdkd local start-service ECS service emulator ([#466](https://github.com/go-to-k/cdkd/issues/466) + [#461](https://github.com/go-to-k/cdkd/issues/461)) ([#504](https://github.com/go-to-k/cdkd/issues/504)) ([7489217](https://github.com/go-to-k/cdkd/commit/7489217e7ea82c7fa5ec991ba23cff3f6e9d978b))

# [0.130.0](https://github.com/go-to-k/cdkd/compare/v0.129.0...v0.130.0) (2026-05-22)


### Features

* **local-start-api:** RESPONSE_STREAM Function URL invoke mode ([#467](https://github.com/go-to-k/cdkd/issues/467)) ([#501](https://github.com/go-to-k/cdkd/issues/501)) ([4891627](https://github.com/go-to-k/cdkd/commit/4891627e5f296770b6c26d519ac66a6a79b10534))

# [0.129.0](https://github.com/go-to-k/cdkd/compare/v0.128.0...v0.129.0) (2026-05-22)


### Features

* **local-start-api:** HTTP API v2 IntegrationSubtype service integrations ([#458](https://github.com/go-to-k/cdkd/issues/458)) ([#500](https://github.com/go-to-k/cdkd/issues/500)) ([0e42c41](https://github.com/go-to-k/cdkd/commit/0e42c417abf9487b9d2b656cc46c9e08e7ae91d8))

# [0.128.0](https://github.com/go-to-k/cdkd/compare/v0.127.0...v0.128.0) (2026-05-22)


### Features

* **local-start-api:** container image Lambda support ([#493](https://github.com/go-to-k/cdkd/issues/493)) ([9817741](https://github.com/go-to-k/cdkd/commit/98177419fe266de4bf5fca37b1e074048587d412))

# [0.127.0](https://github.com/go-to-k/cdkd/compare/v0.126.0...v0.127.0) (2026-05-22)


### Features

* **export:** TemplateURL upload for templates over 51 KB ([#489](https://github.com/go-to-k/cdkd/issues/489)) ([c04e904](https://github.com/go-to-k/cdkd/commit/c04e90455e89504e8ad1d51b6f0e9ed64799f739))

# [0.126.0](https://github.com/go-to-k/cdkd/compare/v0.125.0...v0.126.0) (2026-05-22)


### Features

* **local-start-api:** mTLS authorizer for API Gateway custom-domain client certs ([#492](https://github.com/go-to-k/cdkd/issues/492)) ([957ed82](https://github.com/go-to-k/cdkd/commit/957ed8299743e4cc2f4c00024323ff2136a256a2))

# [0.125.0](https://github.com/go-to-k/cdkd/compare/v0.124.0...v0.125.0) (2026-05-22)


### Features

* **local-invoke:** accept literal layer ARNs (cross-account / cross-region) — closes [#448](https://github.com/go-to-k/cdkd/issues/448) ([#491](https://github.com/go-to-k/cdkd/issues/491)) ([9c30f0e](https://github.com/go-to-k/cdkd/commit/9c30f0e4905cfc02f102a034c84c5f5dcc3a0561))

# [0.124.0](https://github.com/go-to-k/cdkd/compare/v0.123.0...v0.124.0) (2026-05-22)


### Features

* **export:** YAML template support ([#483](https://github.com/go-to-k/cdkd/issues/483)) ([bc69422](https://github.com/go-to-k/cdkd/commit/bc6942273f44b4a807f8ea42058b6140a78352ec))

# [0.123.0](https://github.com/go-to-k/cdkd/compare/v0.122.0...v0.123.0) (2026-05-22)


### Features

* **intrinsic:** Fn::GetStackOutput cross-account RoleArn support ([#490](https://github.com/go-to-k/cdkd/issues/490)) ([ffc284f](https://github.com/go-to-k/cdkd/commit/ffc284f876769aa0ac3e205e3f8cfb01466140c1))

# [0.122.0](https://github.com/go-to-k/cdkd/compare/v0.121.0...v0.122.0) (2026-05-22)


### Features

* **local:** --from-state resolves Fn::ImportValue and Fn::GetStackOutput ([#454](https://github.com/go-to-k/cdkd/issues/454)) ([#487](https://github.com/go-to-k/cdkd/issues/487)) ([628d5e8](https://github.com/go-to-k/cdkd/commit/628d5e87bb7490f1960a9db7109d7cb64fd7143d))

# [0.121.0](https://github.com/go-to-k/cdkd/compare/v0.120.0...v0.121.0) (2026-05-22)


### Features

* **logger:** rich color output + replace hero GIF with side-by-side demo ([#486](https://github.com/go-to-k/cdkd/issues/486)) ([9dee8dc](https://github.com/go-to-k/cdkd/commit/9dee8dcddcd5b7075309005e923dc517b8b1557f))

# [0.120.0](https://github.com/go-to-k/cdkd/compare/v0.119.0...v0.120.0) (2026-05-22)


### Features

* **local-start-api:** REST v1 IAM authorizer SigV4 signature verification ([#447](https://github.com/go-to-k/cdkd/issues/447)) ([#484](https://github.com/go-to-k/cdkd/issues/484)) ([b1a379c](https://github.com/go-to-k/cdkd/commit/b1a379c107b6797e6903c4fee67655300b177884))

# [0.119.0](https://github.com/go-to-k/cdkd/compare/v0.118.0...v0.119.0) (2026-05-22)


### Features

* **local-start-api:** cognito multi-pool federation ([#488](https://github.com/go-to-k/cdkd/issues/488)) ([64a479a](https://github.com/go-to-k/cdkd/commit/64a479a91a7d0af3fdf33fa924d8029196035f34))

# [0.118.0](https://github.com/go-to-k/cdkd/compare/v0.117.2...v0.118.0) (2026-05-21)


### Features

* **local:** cross-account / cross-region ECR pull ([#485](https://github.com/go-to-k/cdkd/issues/485)) ([de4e889](https://github.com/go-to-k/cdkd/commit/de4e889d929754d8d729298ab31ff57772efb6ed))

## [0.117.2](https://github.com/go-to-k/cdkd/compare/v0.117.1...v0.117.2) (2026-05-21)


### Bug Fixes

* **dynamodb-globaltable:** propagate Tags to cross-region replicas on create ([#441](https://github.com/go-to-k/cdkd/issues/441)) ([#472](https://github.com/go-to-k/cdkd/issues/472)) ([c97af8e](https://github.com/go-to-k/cdkd/commit/c97af8e1dcb33f0b3a8463d5da0e389d65338cb1))

## [0.117.1](https://github.com/go-to-k/cdkd/compare/v0.117.0...v0.117.1) (2026-05-21)


### Bug Fixes

* **providers:** clarify architectural update() rejections + implement AppSync in-place update ([#443](https://github.com/go-to-k/cdkd/issues/443)) ([#479](https://github.com/go-to-k/cdkd/issues/479)) ([9f937c1](https://github.com/go-to-k/cdkd/commit/9f937c17fdcd1c9058f6277886b74a2c26f494e2))

# [0.117.0](https://github.com/go-to-k/cdkd/compare/v0.116.1...v0.117.0) (2026-05-21)


### Features

* **local:** honor Lambda EphemeralStorage.Size via --tmpfs ([#478](https://github.com/go-to-k/cdkd/issues/478)) ([a7aa542](https://github.com/go-to-k/cdkd/commit/a7aa542a2180e8a378bdb49dd6430b8165da3115))

## [0.116.1](https://github.com/go-to-k/cdkd/compare/v0.116.0...v0.116.1) (2026-05-21)


### Bug Fixes

* **drift:** reduce getDriftUnknownPaths via secondary SDK calls (batch 1) ([#445](https://github.com/go-to-k/cdkd/issues/445)) ([#469](https://github.com/go-to-k/cdkd/issues/469)) ([488a929](https://github.com/go-to-k/cdkd/commit/488a929901f911e4649793c8d45b424b068fab54))

# [0.116.0](https://github.com/go-to-k/cdkd/compare/v0.115.4...v0.116.0) (2026-05-21)


### Features

* **local-invoke:** auto-resolve --assume-role from state Role property ([#442](https://github.com/go-to-k/cdkd/issues/442)) ([#473](https://github.com/go-to-k/cdkd/issues/473)) ([ca1e382](https://github.com/go-to-k/cdkd/commit/ca1e3824ace7680ff29c9ee8ccaf9dbfff0c2b6b))

## [0.115.4](https://github.com/go-to-k/cdkd/compare/v0.115.3...v0.115.4) (2026-05-21)


### Bug Fixes

* **local:** accept Fn::Sub shapes on AWS::ApiGatewayV2::Route.Target ([#444](https://github.com/go-to-k/cdkd/issues/444)) ([#474](https://github.com/go-to-k/cdkd/issues/474)) ([9940a70](https://github.com/go-to-k/cdkd/commit/9940a70e3cf0d52156f6ed3a44950bdce690cf34))

## [0.115.3](https://github.com/go-to-k/cdkd/compare/v0.115.2...v0.115.3) (2026-05-21)


### Bug Fixes

* **ecr-login:** actionable error when docker credential helper blocks ECR login ([#438](https://github.com/go-to-k/cdkd/issues/438)) ([3e595af](https://github.com/go-to-k/cdkd/commit/3e595af57f67e78d5da39dba9124da510582ea06))

## [0.115.2](https://github.com/go-to-k/cdkd/compare/v0.115.1...v0.115.2) (2026-05-21)


### Bug Fixes

* **docker-build:** align with CDK CLI for # syntax=docker/dockerfile:1 + BuildKit Dockerfiles ([#437](https://github.com/go-to-k/cdkd/issues/437)) ([47b3a97](https://github.com/go-to-k/cdkd/commit/47b3a976c2ab056496afb4d9e117ddc9ac6b7481))

## [0.115.1](https://github.com/go-to-k/cdkd/compare/v0.115.0...v0.115.1) (2026-05-18)


### Bug Fixes

* **local-start-api:** defer authorizer Lambda Arn unresolvable to request time (closes [#431](https://github.com/go-to-k/cdkd/issues/431)) ([#432](https://github.com/go-to-k/cdkd/issues/432)) ([2257920](https://github.com/go-to-k/cdkd/commit/22579205a1530f760779d6fbf888438d59e86505))

# [0.115.0](https://github.com/go-to-k/cdkd/compare/v0.114.1...v0.115.0) (2026-05-18)


### Features

* **local-start-api:** defer unsupported-route errors to request time + REST v1 MOCK CORS preflight ([#430](https://github.com/go-to-k/cdkd/issues/430)) ([2152123](https://github.com/go-to-k/cdkd/commit/2152123f91c5c94500a84a8178dd0a184e77843d))

## [0.114.1](https://github.com/go-to-k/cdkd/compare/v0.114.0...v0.114.1) (2026-05-17)


### Bug Fixes

* **diff:** detect Fn::GetAtt rebinding when target resource is not yet in state ([#429](https://github.com/go-to-k/cdkd/issues/429)) ([438f407](https://github.com/go-to-k/cdkd/commit/438f40726e1842852ebab8664835c4933c1ee40c))

# [0.114.0](https://github.com/go-to-k/cdkd/compare/v0.113.0...v0.114.0) (2026-05-16)


### Features

* **hooks:** integ-coverage-matrix-gate.sh blocks commit when matrix stale ([#428](https://github.com/go-to-k/cdkd/issues/428)) ([fd4f5fe](https://github.com/go-to-k/cdkd/commit/fd4f5fe4f19fb868c532798a9284edc9b54b0f6a))

# [0.113.0](https://github.com/go-to-k/cdkd/compare/v0.112.0...v0.113.0) (2026-05-16)


### Features

* **scripts:** scenario coverage visibility report (Phase 2B of [#392](https://github.com/go-to-k/cdkd/issues/392), closes [#423](https://github.com/go-to-k/cdkd/issues/423)) ([#425](https://github.com/go-to-k/cdkd/issues/425)) ([196f1d8](https://github.com/go-to-k/cdkd/commit/196f1d8ebf00e63826f9bda0b27a86baf1976dd8))

# [0.112.0](https://github.com/go-to-k/cdkd/compare/v0.111.3...v0.112.0) (2026-05-16)


### Features

* **scripts:** CLI flag coverage visibility report (Phase 2A of [#392](https://github.com/go-to-k/cdkd/issues/392)) ([#424](https://github.com/go-to-k/cdkd/issues/424)) ([6650217](https://github.com/go-to-k/cdkd/commit/6650217a361ab5affa672defef86b59a34a31403))

## [0.111.3](https://github.com/go-to-k/cdkd/compare/v0.111.2...v0.111.3) (2026-05-16)


### Bug Fixes

* **dynamodb-globaltable:** neutralize DPE auto-disable WARN wording ([#420](https://github.com/go-to-k/cdkd/issues/420)) ([47abfc6](https://github.com/go-to-k/cdkd/commit/47abfc67a87e5b273a9c1b7cf07bbeb78533a665))

## [0.111.2](https://github.com/go-to-k/cdkd/compare/v0.111.1...v0.111.2) (2026-05-16)


### Bug Fixes

* **dynamodb-globaltable:** warn on DPE auto-disable when property removed from CDK code ([#418](https://github.com/go-to-k/cdkd/issues/418)) ([8a6f49c](https://github.com/go-to-k/cdkd/commit/8a6f49c9d1b3327744f58d1855dd950a5a6fda64))

## [0.111.1](https://github.com/go-to-k/cdkd/compare/v0.111.0...v0.111.1) (2026-05-16)


### Bug Fixes

* **dynamodb-globaltable:** close 3 deferred nits from PR [#410](https://github.com/go-to-k/cdkd/issues/410) review (AWS-aware DPE + TTL error wrap + helper refactor) ([#415](https://github.com/go-to-k/cdkd/issues/415)) ([e8d93cb](https://github.com/go-to-k/cdkd/commit/e8d93cb1bdfb165a339d51a855cfcec78d32feaf))

# [0.111.0](https://github.com/go-to-k/cdkd/compare/v0.110.0...v0.111.0) (2026-05-16)


### Features

* **dynamodb-globaltable:** validate multi-region integ + regional client region-assertion tests (Closes [#407](https://github.com/go-to-k/cdkd/issues/407)) ([#410](https://github.com/go-to-k/cdkd/issues/410)) ([2a13b96](https://github.com/go-to-k/cdkd/commit/2a13b964de99e8c2497be0f4be41d611042afadc))

# [0.110.0](https://github.com/go-to-k/cdkd/compare/v0.109.1...v0.110.0) (2026-05-16)


### Features

* **providers:** drift --revert round-trip audit for RDS DBProxy family + new TG readCurrentState ([#409](https://github.com/go-to-k/cdkd/issues/409)) ([963d2ca](https://github.com/go-to-k/cdkd/commit/963d2ca54c310093190c7d3d5daf7f5da0af156b))

## [0.109.1](https://github.com/go-to-k/cdkd/compare/v0.109.0...v0.109.1) (2026-05-16)


### Bug Fixes

* **providers:** residual work from PR [#400](https://github.com/go-to-k/cdkd/issues/400) + rds-aurora integ extension for DBProxyEndpoint ([#406](https://github.com/go-to-k/cdkd/issues/406)) ([2f4c2a0](https://github.com/go-to-k/cdkd/commit/2f4c2a06f0f47451ee117d742ae314834b201c27))

# [0.109.0](https://github.com/go-to-k/cdkd/compare/v0.108.0...v0.109.0) (2026-05-16)


### Features

* **dynamodb-globaltable:** close all 8 deferred items (Closes [#402](https://github.com/go-to-k/cdkd/issues/402)) ([#403](https://github.com/go-to-k/cdkd/issues/403)) ([b274877](https://github.com/go-to-k/cdkd/commit/b27487743cb7db4a78841e6a1224653a1c52610b))

# [0.108.0](https://github.com/go-to-k/cdkd/compare/v0.107.0...v0.108.0) (2026-05-16)


### Features

* **providers:** AWS::RDS::DBProxyEndpoint SDK Provider + CLAUDE.md signature docs fix ([#400](https://github.com/go-to-k/cdkd/issues/400)) ([0cf0fd9](https://github.com/go-to-k/cdkd/commit/0cf0fd9e3468182ad86ba6eb126ce0d7739deb8c))

# [0.107.0](https://github.com/go-to-k/cdkd/compare/v0.106.0...v0.107.0) (2026-05-16)


### Features

* **dynamodb-globaltable:** full auto-scaling reverse-mapping (Closes [#395](https://github.com/go-to-k/cdkd/issues/395)) ([#397](https://github.com/go-to-k/cdkd/issues/397)) ([4c6ee0a](https://github.com/go-to-k/cdkd/commit/4c6ee0af12854fd4ea8a7309290ab5be0d4f3825))

# [0.106.0](https://github.com/go-to-k/cdkd/compare/v0.105.0...v0.106.0) (2026-05-16)


### Features

* **providers:** AWS::RDS::DBProxy SDK Provider + DBProxyTargetGroup in-place update ([#394](https://github.com/go-to-k/cdkd/issues/394)) ([29bc1cd](https://github.com/go-to-k/cdkd/commit/29bc1cd265114e2afffe1ca4a6346f44538fc997))

# [0.105.0](https://github.com/go-to-k/cdkd/compare/v0.104.0...v0.105.0) (2026-05-16)


### Features

* **dynamodb-globaltable:** close 5 deferred items (cross-region drift + Tags + throughput round-trip + tests + integ) ([#393](https://github.com/go-to-k/cdkd/issues/393)) ([9faf945](https://github.com/go-to-k/cdkd/commit/9faf945b62b60469a44a6961ca55b4e690b732b6))

# [0.104.0](https://github.com/go-to-k/cdkd/compare/v0.103.2...v0.104.0) (2026-05-15)


### Features

* **dynamodb-globaltable:** complete provider coverage (follow-up to [#384](https://github.com/go-to-k/cdkd/issues/384)) ([#388](https://github.com/go-to-k/cdkd/issues/388)) ([a15654c](https://github.com/go-to-k/cdkd/commit/a15654cdfb5e8a7291fe830ba128666bf856bed2))

## [0.103.2](https://github.com/go-to-k/cdkd/compare/v0.103.1...v0.103.2) (2026-05-15)


### Bug Fixes

* **providers:** dedicated SDK Provider for AWS::RDS::DBProxyTargetGroup ([#387](https://github.com/go-to-k/cdkd/issues/387)) ([d7dc38d](https://github.com/go-to-k/cdkd/commit/d7dc38db6a6cf5f30c9dbae99e65879b5606ea70))

## [0.103.1](https://github.com/go-to-k/cdkd/compare/v0.103.0...v0.103.1) (2026-05-15)


### Bug Fixes

* **intrinsic-resolver, cc-api:** resolve nested attribute paths for RDS DBCluster Endpoint.Port ([#386](https://github.com/go-to-k/cdkd/issues/386)) ([3281dc9](https://github.com/go-to-k/cdkd/commit/3281dc9b645dd0bc7f7313943add3749edd7323d))

# [0.103.0](https://github.com/go-to-k/cdkd/compare/v0.102.7...v0.103.0) (2026-05-15)


### Features

* **providers:** add SDK Provider for AWS::DynamoDB::GlobalTable (TableV2) ([#384](https://github.com/go-to-k/cdkd/issues/384)) ([fec9eb9](https://github.com/go-to-k/cdkd/commit/fec9eb9da0c076abb1687e5706ed124c845a69c9))

## [0.102.7](https://github.com/go-to-k/cdkd/compare/v0.102.6...v0.102.7) (2026-05-15)


### Bug Fixes

* **providers:** clean up partial create orphans in RDS DBCluster (Closes [#376](https://github.com/go-to-k/cdkd/issues/376)) ([#382](https://github.com/go-to-k/cdkd/issues/382)) ([b5a8831](https://github.com/go-to-k/cdkd/commit/b5a88319a95677e47fdf8f4c8e45ece89a71409c))

## [0.102.6](https://github.com/go-to-k/cdkd/compare/v0.102.5...v0.102.6) (2026-05-15)


### Bug Fixes

* **providers:** clean up partial create orphans in EventBridge Rule / SNS Topic / ELBv2 LoadBalancer (Refs [#376](https://github.com/go-to-k/cdkd/issues/376)) ([#380](https://github.com/go-to-k/cdkd/issues/380)) ([62366b2](https://github.com/go-to-k/cdkd/commit/62366b2793c23eb369ad409e465706dd9cc024ee))

## [0.102.5](https://github.com/go-to-k/cdkd/compare/v0.102.4...v0.102.5) (2026-05-15)


### Bug Fixes

* **providers:** clean up partial create orphans in EC2 VPC / Subnet / SecurityGroup / Instance (Refs [#376](https://github.com/go-to-k/cdkd/issues/376)) ([#379](https://github.com/go-to-k/cdkd/issues/379)) ([bb57c4a](https://github.com/go-to-k/cdkd/commit/bb57c4a4872595e9b78815f86e12138e11a1190a))

## [0.102.4](https://github.com/go-to-k/cdkd/compare/v0.102.3...v0.102.4) (2026-05-15)


### Bug Fixes

* **providers:** clean up partial create orphans in IAM Role / User / Group / InstanceProfile (Refs [#376](https://github.com/go-to-k/cdkd/issues/376)) ([#378](https://github.com/go-to-k/cdkd/issues/378)) ([66747f6](https://github.com/go-to-k/cdkd/commit/66747f627cff25ec5b46d9a66927d3b6a14ba1f3))

## [0.102.3](https://github.com/go-to-k/cdkd/compare/v0.102.2...v0.102.3) (2026-05-15)


### Bug Fixes

* **providers:** clean up partial create orphans in S3 / Logs / SSM (Refs [#376](https://github.com/go-to-k/cdkd/issues/376)) ([#377](https://github.com/go-to-k/cdkd/issues/377)) ([04e37e2](https://github.com/go-to-k/cdkd/commit/04e37e21df6896d16a0641e348a24811fc4496dc))

## [0.102.2](https://github.com/go-to-k/cdkd/compare/v0.102.1...v0.102.2) (2026-05-15)


### Bug Fixes

* **apigateway:** clean up partial Method create on wiring failure ([#374](https://github.com/go-to-k/cdkd/issues/374)) ([0c18317](https://github.com/go-to-k/cdkd/commit/0c1831705d6f4536d8ac64ede761aa7b9a948a74))

## [0.102.1](https://github.com/go-to-k/cdkd/compare/v0.102.0...v0.102.1) (2026-05-15)


### Bug Fixes

* **apigateway:** create MethodResponses before IntegrationResponses ([#373](https://github.com/go-to-k/cdkd/issues/373)) ([9182499](https://github.com/go-to-k/cdkd/commit/9182499d858866a56813697fde3241853e8cb992))

# [0.102.0](https://github.com/go-to-k/cdkd/compare/v0.101.2...v0.102.0) (2026-05-15)


### Features

* **deploy:** print CloudFormation Outputs after deploy ([#372](https://github.com/go-to-k/cdkd/issues/372)) ([1695a55](https://github.com/go-to-k/cdkd/commit/1695a5587f3f7554ae63bc999e74af90abb59dd6))

## [0.101.2](https://github.com/go-to-k/cdkd/compare/v0.101.1...v0.101.2) (2026-05-15)


### Bug Fixes

* **apigateway:** forward all Integration and Method properties in createMethod ([#370](https://github.com/go-to-k/cdkd/issues/370)) ([149fd2a](https://github.com/go-to-k/cdkd/commit/149fd2a1ff5e1c1196db539a6fb48d5e1ed5eb46))

## [0.101.1](https://github.com/go-to-k/cdkd/compare/v0.101.0...v0.101.1) (2026-05-15)


### Bug Fixes

* **release:** clear npm publish warnings on bin path + repository url ([#371](https://github.com/go-to-k/cdkd/issues/371)) ([683e885](https://github.com/go-to-k/cdkd/commit/683e88579f090b2e1272ae44b6c5b32a9fc17843))

# [0.101.0](https://github.com/go-to-k/cdkd/compare/v0.100.3...v0.101.0) (2026-05-15)


### Features

* **destroy:** honor DeletionPolicy: Retain in cdkd state destroy too ([#369](https://github.com/go-to-k/cdkd/issues/369)) ([17e15a1](https://github.com/go-to-k/cdkd/commit/17e15a1166429efcfd6a83e04f41c39f1f19659b))

## [0.100.3](https://github.com/go-to-k/cdkd/compare/v0.100.2...v0.100.3) (2026-05-15)


### Bug Fixes

* **release:** rebuild after version bump so cdkd --version matches package.json ([#368](https://github.com/go-to-k/cdkd/issues/368)) ([a7a4e11](https://github.com/go-to-k/cdkd/commit/a7a4e11e0e5a3418f9ac776f505c99fe95236a0c))

## [0.100.2](https://github.com/go-to-k/cdkd/compare/v0.100.1...v0.100.2) (2026-05-15)


### Bug Fixes

* **intrinsics:** add per-type Arn handlers for 18 missing resource types ([#367](https://github.com/go-to-k/cdkd/issues/367)) ([aae6297](https://github.com/go-to-k/cdkd/commit/aae6297497da6f5fe80170e024263c787808787d))

## [0.100.1](https://github.com/go-to-k/cdkd/compare/v0.100.0...v0.100.1) (2026-05-15)


### Bug Fixes

* **intrinsics:** add AWS::DynamoDB::GlobalTable Fn::GetAtt Arn handler ([#365](https://github.com/go-to-k/cdkd/issues/365)) ([b0fa1d1](https://github.com/go-to-k/cdkd/commit/b0fa1d1779706c59d202d44be12de32b49d00030))

# [0.100.0](https://github.com/go-to-k/cdkd/compare/v0.99.3...v0.100.0) (2026-05-15)


### Features

* **diff:** detect DeletionPolicy / UpdateReplacePolicy template-attribute changes ([#364](https://github.com/go-to-k/cdkd/issues/364)) ([5487720](https://github.com/go-to-k/cdkd/commit/548772037cfe65e794391f2cceb8f5a86140c709))

## [0.99.3](https://github.com/go-to-k/cdkd/compare/v0.99.2...v0.99.3) (2026-05-15)


### Bug Fixes

* **synth:** exclude AWS::CDK::Metadata from displayed resource count ([#363](https://github.com/go-to-k/cdkd/issues/363)) ([10f96b2](https://github.com/go-to-k/cdkd/commit/10f96b29f1bc08187a0bea7bb77cb74972dd06e2))

## [0.99.2](https://github.com/go-to-k/cdkd/compare/v0.99.1...v0.99.2) (2026-05-13)


### Bug Fixes

* **import:** pre-resolve {Ref: X} intrinsics against overrides before provider.import ([#361](https://github.com/go-to-k/cdkd/issues/361)) ([#362](https://github.com/go-to-k/cdkd/issues/362)) ([74707d0](https://github.com/go-to-k/cdkd/commit/74707d037989c0b391923dbdaa12d3565c3607af))

## [0.99.1](https://github.com/go-to-k/cdkd/compare/v0.99.0...v0.99.1) (2026-05-13)


### Bug Fixes

* **import:** SNS TopicPolicy + S3 BucketPolicy use operational id ([#356](https://github.com/go-to-k/cdkd/issues/356)) ([#358](https://github.com/go-to-k/cdkd/issues/358)) ([a08bf06](https://github.com/go-to-k/cdkd/commit/a08bf0632cd0f9700bdc60bb32750c907fc6bb6c))

# [0.99.0](https://github.com/go-to-k/cdkd/compare/v0.98.2...v0.99.0) (2026-05-13)


### Features

* **local-start-api:** add --from-state for env var substitution ([#355](https://github.com/go-to-k/cdkd/issues/355)) ([b724eba](https://github.com/go-to-k/cdkd/commit/b724ebaa4394f039a3e872e6f778f00e39609193))

## [0.98.2](https://github.com/go-to-k/cdkd/compare/v0.98.1...v0.98.2) (2026-05-13)


### Bug Fixes

* **import:** SQS QueuePolicy uses queue URL as physicalId ([#351](https://github.com/go-to-k/cdkd/issues/351)) ([#354](https://github.com/go-to-k/cdkd/issues/354)) ([0511b8f](https://github.com/go-to-k/cdkd/commit/0511b8ff3289b2ca4c9e62b19099ddb2279d35ed))

## [0.98.1](https://github.com/go-to-k/cdkd/compare/v0.98.0...v0.98.1) (2026-05-13)


### Bug Fixes

* **state:** perf opts + integ-broad gate (PR [#348](https://github.com/go-to-k/cdkd/issues/348) incident response) ([#349](https://github.com/go-to-k/cdkd/issues/349)) ([e73e223](https://github.com/go-to-k/cdkd/commit/e73e2232a17022d2ce97f1c93b54e68d7904ffa9))

# [0.98.0](https://github.com/go-to-k/cdkd/compare/v0.97.0...v0.98.0) (2026-05-13)


### Features

* **state:** Fn::ImportValue strong reference + persistent exports index ([#343](https://github.com/go-to-k/cdkd/issues/343)) ([#348](https://github.com/go-to-k/cdkd/issues/348)) ([7c4238c](https://github.com/go-to-k/cdkd/commit/7c4238c5045eefd1b26b5645fa139d2c90153aa1))

# [0.97.0](https://github.com/go-to-k/cdkd/compare/v0.96.1...v0.97.0) (2026-05-13)


### Features

* **review-pr:** add **/*.md to pure-docs down-bias bucket ([#346](https://github.com/go-to-k/cdkd/issues/346)) ([35e647f](https://github.com/go-to-k/cdkd/commit/35e647f5cad214673fed611334ab19bae89a4147))

## [0.96.1](https://github.com/go-to-k/cdkd/compare/v0.96.0...v0.96.1) (2026-05-13)


### Bug Fixes

* **integ:** unbreak all local-* integ fixtures on Node 24 ESM + scope-cross check in /verify-pr ([#345](https://github.com/go-to-k/cdkd/issues/345)) ([e821127](https://github.com/go-to-k/cdkd/commit/e8211279fc76bf6d1db69a4184223394931aaebb))

# [0.96.0](https://github.com/go-to-k/cdkd/compare/v0.95.0...v0.96.0) (2026-05-13)


### Features

* **local-start-api:** positional <target> + --api deprecation + strict multi-stack ([#341](https://github.com/go-to-k/cdkd/issues/341)) ([cf840dd](https://github.com/go-to-k/cdkd/commit/cf840dd017928f30b580088e9bd1d52f7b524d6f))

# [0.95.0](https://github.com/go-to-k/cdkd/compare/v0.94.15...v0.95.0) (2026-05-13)


### Features

* **local-start-api:** --api accepts CDK Construct path + stack-qualified logical id ([#340](https://github.com/go-to-k/cdkd/issues/340)) ([2ab74b8](https://github.com/go-to-k/cdkd/commit/2ab74b8c60833d911fa5e3c8a2f1258db1f26d24))

## [0.94.15](https://github.com/go-to-k/cdkd/compare/v0.94.14...v0.94.15) (2026-05-13)


### Bug Fixes

* **pr-review-gate:** resolve marker scope via git-common-dir for worktree-shared state ([#339](https://github.com/go-to-k/cdkd/issues/339)) ([3c0265b](https://github.com/go-to-k/cdkd/commit/3c0265b0ee1c00e4554176d270b1fa829ad0b5fd))

## [0.94.14](https://github.com/go-to-k/cdkd/compare/v0.94.13...v0.94.14) (2026-05-12)


### Bug Fixes

* **custom-resource:** type-guard ServiceToken so unresolved-intrinsic state yields actionable error ([#333](https://github.com/go-to-k/cdkd/issues/333)) ([2b4002a](https://github.com/go-to-k/cdkd/commit/2b4002ae31f2bd2549afb4362c48287b75048d93))

## [0.94.13](https://github.com/go-to-k/cdkd/compare/v0.94.12...v0.94.13) (2026-05-12)


### Bug Fixes

* **import:** resolve CFn intrinsics in state.properties so destroy can read sub-resource refs ([#332](https://github.com/go-to-k/cdkd/issues/332)) ([b04cfa4](https://github.com/go-to-k/cdkd/commit/b04cfa4fab83166c21fed918c8c545c00e4b8b48))

## [0.94.12](https://github.com/go-to-k/cdkd/compare/v0.94.11...v0.94.12) (2026-05-12)


### Bug Fixes

* **intrinsic-resolver:** add AWS::ECR::Repository Arn / RepositoryUri handlers ([#331](https://github.com/go-to-k/cdkd/issues/331)) ([5a1aa38](https://github.com/go-to-k/cdkd/commit/5a1aa38ede215df029e0350f09ad2b2821d391c7))

## [0.94.11](https://github.com/go-to-k/cdkd/compare/v0.94.10...v0.94.11) (2026-05-12)


### Bug Fixes

* **drift:** IAM Role inline policies managed by sibling resource no longer fire false drift; Custom::* silent ([#323](https://github.com/go-to-k/cdkd/issues/323)) ([#324](https://github.com/go-to-k/cdkd/issues/324)) ([94e615b](https://github.com/go-to-k/cdkd/commit/94e615bceb567b9841b986d18e3593ec83dcc6ae))

## [0.94.10](https://github.com/go-to-k/cdkd/compare/v0.94.9...v0.94.10) (2026-05-12)


### Bug Fixes

* **tests:** use 'vp run build' instead of stale 'pnpm run build' in 6 verify.sh files ([#321](https://github.com/go-to-k/cdkd/issues/321)) ([#322](https://github.com/go-to-k/cdkd/issues/322)) ([d139ee8](https://github.com/go-to-k/cdkd/commit/d139ee8519494d2591958878e5c06fa0eaaf4d9c))

## [0.94.9](https://github.com/go-to-k/cdkd/compare/v0.94.8...v0.94.9) (2026-05-12)


### Bug Fixes

* **export:** conditional overlay on Properties to mirror upstream `cdk import` ([#319](https://github.com/go-to-k/cdkd/issues/319)) ([#320](https://github.com/go-to-k/cdkd/issues/320)) ([7926d94](https://github.com/go-to-k/cdkd/commit/7926d948cfc65ea1ab9836de204442c5aae2449b))

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
