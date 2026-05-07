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
