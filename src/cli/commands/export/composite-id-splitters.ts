import { showRecordValue } from './render.js';
import {
  EIP_ALLOCATION_ID_PREFIX,
  EIP_PUBLIC_IP_PATTERN,
  VPC_CIDR_ASSOCIATION_ID_PREFIX,
  VPC_ID_PATTERN,
  readStringProperty,
  resolveGatewayAttachmentType,
  resolveRouteDestination,
  restApiChildSplitter,
} from './composite-id-shapes.js';

/**
 * Hardcoded fallback map for the per-resource-type primary identifier
 * property name. Used only when `DescribeType` fails (e.g. permissions
 * gap, throttling, or an obscure type that has no public registry entry).
 *
 * The string value is the SINGLE property name CFn expects in
 * `ResourcesToImport[].ResourceIdentifier`. For composite-identifier
 * types (`primaryIdentifier` length > 1) we do not have a fallback —
 * the call must succeed against `DescribeType` for those.
 *
 * Source: the `primaryIdentifier` field of each type's published
 * CloudFormation resource schema.
 */
export const PRIMARY_IDENTIFIER_FALLBACK: Record<string, string> = {
  'AWS::S3::Bucket': 'BucketName',
  'AWS::IAM::Role': 'RoleName',
  'AWS::IAM::ManagedPolicy': 'PolicyArn',
  'AWS::IAM::User': 'UserName',
  'AWS::IAM::Group': 'GroupName',
  'AWS::IAM::InstanceProfile': 'InstanceProfileName',
  'AWS::Lambda::Function': 'FunctionName',
  'AWS::DynamoDB::Table': 'TableName',
  'AWS::SQS::Queue': 'QueueUrl',
  'AWS::SNS::Topic': 'TopicArn',
  'AWS::Logs::LogGroup': 'LogGroupName',
  'AWS::EC2::VPC': 'VpcId',
  'AWS::EC2::Subnet': 'SubnetId',
  'AWS::EC2::SecurityGroup': 'GroupId',
  'AWS::EC2::InternetGateway': 'InternetGatewayId',
  'AWS::EC2::RouteTable': 'RouteTableId',
  'AWS::EC2::NatGateway': 'NatGatewayId',
  'AWS::CloudFront::Distribution': 'Id',
  'AWS::CloudFront::CloudFrontOriginAccessIdentity': 'Id',
  'AWS::Route53::HostedZone': 'Id',
  'AWS::SecretsManager::Secret': 'Id',
  'AWS::Events::Rule': 'Arn',
  'AWS::Events::EventBus': 'Name',
  'AWS::ApiGateway::RestApi': 'RestApiId',
  'AWS::ApiGatewayV2::Api': 'ApiId',
  'AWS::CloudWatch::Alarm': 'AlarmName',
  'AWS::Kinesis::Stream': 'Name',
  'AWS::SSM::Parameter': 'Name',
  'AWS::StepFunctions::StateMachine': 'Arn',
  'AWS::Cognito::UserPool': 'UserPoolId',
  'AWS::ECR::Repository': 'RepositoryName',
};

/**
 * Per-type splitter for composite primary identifiers — CloudFormation
 * resource types whose `primaryIdentifier` has more than one field.
 *
 * Inputs:
 * - `physicalId`: the value `provider.create()` returned and cdkd persisted.
 * - `properties`: cdkd state's recorded properties for the resource. Some
 *   sub-resource types (ApiGwV2 Integration / Route, Lambda::Permission)
 *   only carry the secondary id in `physicalId` and rely on
 *   `properties[<parentField>]` (e.g. `properties.ApiId`) for the parent
 *   key. Splitters that don't need this can ignore the arg.
 *
 * Output: `CompositeIdResult` with two maps:
 * - `resourceIdentifier`: every `primaryIdentifier` field CFn schema declares.
 *   This is the map sent to CFn's `ResourcesToImport[].ResourceIdentifier`
 *   and MUST be complete (CFn rejects partial identifiers).
 * - `propertiesOverlay` (optional): subset of `resourceIdentifier` to write
 *   into the synth template's `Properties` block. Defaults to the full
 *   `resourceIdentifier` map — correct for `AWS::ApiGateway::Method`, which
 *   has NO `readOnlyProperties` at all (live `DescribeType`, us-east-1,
 *   2026-08-12) — and for `AWS::ApiGateway::Stage` / `AWS::ApiGateway::Model`,
 *   which likewise declare none.
 *   Sub-resource types whose
 *   primaryIdentifier includes a generated-id field (`ResourceId` /
 *   `IntegrationId` / `RouteId` / Lambda::Permission's `Id`) MUST narrow to just the writable
 *   subset — those generated-id fields ARE listed in the CFn schema's
 *   `properties` block but tagged `readOnlyProperties`, so writing them
 *   via Properties at IMPORT changeset creation is rejected by CFn. The
 *   `resourceIdentifier` map sent to CFn's `ResourcesToImport[]` still
 *   carries the full set — the narrowing only affects template-Properties
 *   writing.
 *
 * cdkd's own per-type physicalId format is provider-defined (see
 * `src/provisioning/providers/*.ts` — most composites use `|` as the
 * separator; sub-resource types store only the secondary id). When the
 * per-type format does NOT match the order CFn expects (e.g.
 * `AWS::ApiGateway::Deployment` stores a bare `deploymentId` — or, on the
 * Cloud Control route, `deploymentId|restApiId` — while CFn primaryIdentifier
 * is `[DeploymentId, RestApiId]`), the splitter reorders explicitly. A field
 * CFn declares but cdkd never stores (`AWS::EC2::VPCGatewayAttachment`'s
 * read-only `AttachmentType`) is DERIVED from the recorded properties.
 *
 * Adding a new composite type: identify cdkd's physicalId format in the
 * matching `src/provisioning/providers/*.ts`, look up the CFn primary
 * identifier via `aws cloudformation describe-type` or the resource schema
 * docs, decide whether each field is a valid Property, and add an entry below.
 */
export interface CompositeIdResult {
  resourceIdentifier: Record<string, string>;
  propertiesOverlay?: Record<string, string>;
}

export type CompositeIdSplitter = (
  physicalId: string,
  properties: Record<string, unknown>
) => CompositeIdResult;

export const COMPOSITE_ID_SPLITTERS: Record<string, CompositeIdSplitter> = {
  // cdkd stores `restApiId|resourceId|httpMethod` (apigateway-provider.ts);
  // CFn primary identifier is [RestApiId, ResourceId, HttpMethod] — same
  // order, and all three are writable Properties of AWS::ApiGateway::Method.
  'AWS::ApiGateway::Method': (id) => {
    const parts = id.split('|');
    if (parts.length !== 3) {
      throw new Error(
        `expected 3 parts (restApiId|resourceId|httpMethod), got ${parts.length}: ${showRecordValue(id)}`
      );
    }
    const map = { RestApiId: parts[0]!, ResourceId: parts[1]!, HttpMethod: parts[2]! };
    return { resourceIdentifier: map };
  },
  // cdkd's SDK provider stores the BARE `resourceId` — `createResource`
  // returns `response.id` and every other method treats the physicalId as a
  // bare id, reading the parent `RestApiId` from the recorded properties. The
  // The Cloud Control path produces `restApiId|resourceId` (CC joins a
  // multi-part primaryIdentifier with `|`). That path is LIVE, not
  // historical: the #614 SDK-unwired rule still auto-routes these types
  // through Cloud Control, so both shapes exist in state in the wild and BOTH
  // are accepted here. Requiring the composite made
  // `cdkd export` throw on every SDK-created Resource — on a value cdkd
  // itself wrote (issue #1663).
  //
  // CFn primary identifier is [RestApiId, ResourceId], but unlike
  // AWS::ApiGateway::Method (which has NO read-only properties, verified live
  // us-east-1 2026-08-12) `ResourceId` is `readOnlyProperties` here — so it is
  // EXCLUDED from propertiesOverlay. Same narrowing, same reason, as the
  // ApiGatewayV2::Integration splitter below.
  //
  // This is defense-in-depth rather than a live bug fix:
  // `overlayResourceIdentifierOnProperties` writes a field ONLY when the
  // template already carries it as a literal string, and a synthesized
  // AWS::ApiGateway::Resource has RestApiId / ParentId / PathPart and no
  // ResourceId — so the default overlay would have skipped it anyway. Narrow
  // it explicitly so the safety does not depend on that conditional.
  'AWS::ApiGateway::Resource': (physicalId, properties) => {
    // `.trim()`, not truthiness: a blank id is as unusable as an empty one
    // and would otherwise ship `ResourceId: ' '` into the changeset.
    if (!physicalId.trim()) {
      throw new Error('empty physical id for AWS::ApiGateway::Resource (expected a resourceId)');
    }
    const parts = physicalId.split('|');
    if (parts.length > 2) {
      throw new Error(
        `expected a bare resourceId or 'restApiId|resourceId', got ${parts.length} parts: ${showRecordValue(physicalId)}`
      );
    }
    if (parts.length === 2) {
      const [restApiId, resourceId] = parts as [string, string];
      if (!restApiId || !resourceId) {
        throw new Error(`empty part in 'restApiId|resourceId': ${showRecordValue(physicalId)}`);
      }
      return {
        resourceIdentifier: { RestApiId: restApiId, ResourceId: resourceId },
        propertiesOverlay: { RestApiId: restApiId },
      };
    }
    const restApiId = readStringProperty(properties, 'RestApiId', 'AWS::ApiGateway::Resource');
    return {
      resourceIdentifier: { RestApiId: restApiId, ResourceId: physicalId },
      propertiesOverlay: { RestApiId: restApiId },
    };
  },
  // cdkd's SDK provider stores `<gatewayId>|<vpcId>` (ec2-provider.ts's
  // `createVpcGatewayAttachment`); the Cloud Control path — reached whenever
  // the template trips the #614 SDK-unwired rule, e.g. by declaring
  // `VpnGatewayId`, which the SDK provider does not handle — stores the CFn
  // primaryIdentifier joined, i.e. `<AttachmentType>|<vpcId>`. Both shapes
  // exist in state in the wild, so both are accepted.
  //
  // CFn primary identifier is [AttachmentType, VpcId] (live `DescribeType`,
  // us-east-1, 2026-08-12) — NOT the [VpcId, InternetGatewayId] this entry
  // claimed before issue #1691, which made `resolveCompositeId`'s field check
  // throw and aborted `cdkd export` on every stack with a VPC + IGW.
  // `AttachmentType` is `readOnlyProperties`, so the overlay narrows to
  // `VpcId` — same narrowing, same reason, as the ApiGatewayV2::Integration
  // splitter below.
  'AWS::EC2::VPCGatewayAttachment': (physicalId, properties) => {
    const parts = physicalId.split('|');
    if (parts.length !== 2) {
      throw new Error(
        `expected 2 parts ('<gatewayId>|<vpcId>' or '<AttachmentType>|<vpcId>'), ` +
          `got ${parts.length}: ${showRecordValue(physicalId)}`
      );
    }
    const [first, vpcId] = parts as [string, string];
    if (!first || !vpcId) {
      throw new Error(`empty part in composite physical id: ${showRecordValue(physicalId)}`);
    }
    return {
      resourceIdentifier: {
        AttachmentType: resolveGatewayAttachmentType(first, properties),
        VpcId: vpcId,
      },
      propertiesOverlay: { VpcId: vpcId },
    };
  },
  // No SDK provider registers `AWS::EC2::VPCCidrBlock`, so it is always
  // Cloud-Control-routed and cdkd's physicalId is the CC primaryIdentifier
  // joined with `|` in schema order: `<Id>|<VpcId>`. CFn primary identifier is
  // [Id, VpcId] and `Id` is `readOnlyProperties` (live `DescribeType`,
  // us-east-1, 2026-08-13), so the overlay narrows to `VpcId` — same
  // narrowing, same reason, as the `AWS::EC2::VPCGatewayAttachment` entry
  // above and the `AWS::EC2::Route` entry below.
  //
  // The two segments ARE discriminable by shape and this splitter binds them,
  // the way the `AWS::EC2::EIP` entry below binds `eipalloc-` — the association
  // id carries the distinct `vpc-cidr-assoc-` prefix while the VPC id does not.
  // BOTH sides are checked, for the same reason the EIP entry gives: validating
  // one side only is not a discriminator. A swapped pair would otherwise ship a
  // `ResourceIdentifier` naming a different resource and fail opaquely at
  // changeset-create.
  //
  // The BARE `<Id>` form is accepted DEFENSIVELY — no cdkd writer records it.
  // CloudFormation reports an `AWS::EC2::VPCCidrBlock`'s `PhysicalResourceId` as
  // the association id alone, but Cloud Control rejects that as an identifier
  // (`ValidationException: Identifier vpc-cidr-assoc-… is not valid for
  // identifier [/properties/Id, /properties/VpcId]`, measured us-east-1,
  // 2026-09-25), and `CloudControlProvider.import()` records a physicalId only
  // after `GetResource` succeeds. So an import that passed the bare id through
  // adopted nothing, and since #3701 (issue #3672) a migrate completes it to
  // `<Id>|<VpcId>` first. A hand-edited state record is what remains. `VpcId`
  // is then recovered from the recorded properties, exactly as the
  // `AWS::ApiGateway::Resource` entry above recovers `RestApiId`.
  //
  // Without this entry the type's mere PRESENCE aborted the whole
  // `cdkd export` command — and any VPC carrying a secondary IPv4 CIDR or an
  // Amazon-provided IPv6 CIDR declares one, including every CDK `Vpc`
  // configured with `ipProtocol: IpProtocol.DUAL_STACK` (issue #1788).
  'AWS::EC2::VPCCidrBlock': (physicalId, properties) => {
    // `.trim()`, not truthiness — a blank segment is as unusable as an empty
    // one and would otherwise ship `Id: ' '`. Same guard, same reason, as the
    // `AWS::EC2::Route` and `AWS::ApiGateway::Resource` entries.
    if (!physicalId.trim()) {
      throw new Error('empty physical id for AWS::EC2::VPCCidrBlock (expected an association id)');
    }
    const parts = physicalId.split('|').map((p) => p.trim());
    if (parts.length > 2) {
      throw new Error(
        `expected a bare '<Id>' or '<Id>|<VpcId>', got ${parts.length} parts: ${showRecordValue(physicalId)}`
      );
    }
    const id = parts[0]!;
    if (!id) {
      throw new Error(`empty part in '<Id>|<VpcId>': ${showRecordValue(physicalId)}`);
    }
    if (!id.startsWith(VPC_CIDR_ASSOCIATION_ID_PREFIX)) {
      throw new Error(
        `${showRecordValue(physicalId)} does not start with an association id: CloudFormation identifies an ` +
          `AWS::EC2::VPCCidrBlock by [Id, VpcId], so the first segment must be a ` +
          `'${VPC_CIDR_ASSOCIATION_ID_PREFIX}…' id. State entry may be corrupt, or the segments ` +
          `may be reversed; re-deploy the resource to refresh state`
      );
    }
    let vpcId: string;
    if (parts.length === 2) {
      vpcId = parts[1]!;
      // Only reachable on THIS branch — `readStringProperty` already refuses an
      // empty / non-string recorded value on the bare-id branch below.
      if (!vpcId) {
        throw new Error(`empty part in '<Id>|<VpcId>': ${showRecordValue(physicalId)}`);
      }
    } else {
      vpcId = readStringProperty(properties, 'VpcId', 'AWS::EC2::VPCCidrBlock');
    }
    // The VPC id must NOT itself be an association id — `vpc-cidr-assoc-a|vpc-cidr-assoc-b`
    // satisfies the first-segment guard above and then ships a `VpcId` naming
    // nothing. Checking one side only is not a discriminator.
    if (!VPC_ID_PATTERN.test(vpcId)) {
      throw new Error(
        `${showRecordValue(vpcId)} is not a VPC id (expected 'vpc-…', not an association id): ` +
          `${showRecordValue(physicalId)} may have its segments reversed`
      );
    }
    return {
      resourceIdentifier: { Id: id, VpcId: vpcId },
      propertiesOverlay: { VpcId: vpcId },
    };
  },
  // cdkd's SDK provider stores `<routeTableId>|<destination>` (ec2-provider.ts's
  // `createRoute`), where `destination` is whichever of `DestinationCidrBlock` /
  // `DestinationIpv6CidrBlock` / `DestinationPrefixListId` the route declares —
  // `narrowRouteDestinations` resolves them in that precedence order. The Cloud
  // Control path (reached when the template trips the #614 SDK-unwired rule)
  // stores the CFn primaryIdentifier joined, which is the SAME
  // `<RouteTableId>|<CidrBlock>` string, so both shapes coincide here and no
  // second form has to be accepted.
  //
  // CFn primary identifier is [RouteTableId, CidrBlock] with `CidrBlock`
  // `readOnlyProperties` (live `DescribeType`, us-east-1, 2026-08-13), so the
  // overlay narrows to `RouteTableId` — same narrowing, same reason, as the
  // `AWS::EC2::VPCGatewayAttachment` entry above.
  //
  // The one subtlety is what `CidrBlock` HOLDS. It is a single read-only field
  // and the schema gives it an empty description, so "the identifier is the
  // IPv4 CIDR" is the natural (and wrong) reading. Measured live instead —
  // Cloud Control `GetResource` against a scratch route table carrying both
  // destination shapes, us-east-1, 2026-08-13:
  //
  //   `rtb-…|0.0.0.0/0`   -> {"CidrBlock":"0.0.0.0/0","DestinationCidrBlock":"0.0.0.0/0",…}
  //   `rtb-…|::/0`        -> {"CidrBlock":"::/0","DestinationIpv6CidrBlock":"::/0",…}
  //   `rtb-…|pl-63a5400a` -> {"CidrBlock":"pl-63a5400a","DestinationPrefixListId":"pl-63a5400a",…}
  //
  // — i.e. `CidrBlock` carries whichever destination the route declares, so the
  // physicalId's destination segment maps onto it verbatim and this splitter
  // needs no per-destination-key branch. The recorded properties are still read
  // (see {@link resolveRouteDestination}) because the id and the properties can
  // legitimately diverge on the Cloud Control path, and surfacing that beats an
  // opaque CFn IMPORT rejection (issue #1771).
  'AWS::EC2::Route': (physicalId, properties) => {
    const parts = physicalId.split('|');
    if (parts.length !== 2) {
      throw new Error(
        `expected 2 parts ('<routeTableId>|<destination>'), got ${parts.length}: ${showRecordValue(physicalId)}`
      );
    }
    const [routeTableId, destination] = parts as [string, string];
    // `.trim()`, not truthiness: `'  |  '` is two non-empty segments by
    // truthiness and would ship `RouteTableId: '  '` into the changeset.
    if (!routeTableId.trim() || !destination.trim()) {
      throw new Error(
        `empty part in '<routeTableId>|<destination>': ${showRecordValue(physicalId)}`
      );
    }
    return {
      resourceIdentifier: {
        RouteTableId: routeTableId,
        CidrBlock: resolveRouteDestination(destination, properties),
      },
      propertiesOverlay: { RouteTableId: routeTableId },
    };
  },
  // cdkd's SDK provider stores `<publicIp>|<allocationId>` (ec2-provider.ts's
  // `eipPhysicalId`), deliberately the same shape the Cloud Control fallback
  // produced — and `verifyExplicit` normalizes an imported EIP to it too, so
  // every state record written by a create OR an import carries both segments.
  //
  // CFn primary identifier is [PublicIp, AllocationId] — same order — and BOTH
  // fields are `readOnlyProperties` (live `DescribeType`, us-east-1,
  // 2026-08-13; the type declares no `required` properties at all). So nothing
  // may be overlaid onto the synth template's `Properties`: the overlay is an
  // explicit empty map, exactly as `COMPOSITE_PHYSICAL_ID_IDENTIFIERS`'
  // all-read-only entries do, rather than relying on the overlay site's
  // "only writes a field the template already carries" conditional.
  //
  // A bare segment (`eipalloc-…` or a lone public IP) is tolerated by the
  // provider's own `parseEipPhysicalId`, but it cannot produce BOTH identifier
  // fields, so it is refused here with a re-deploy hint rather than sent to CFn
  // half-filled (CFn rejects a partial identifier).
  'AWS::EC2::EIP': (physicalId) => {
    const parts = physicalId.split('|');
    if (parts.length !== 2) {
      throw new Error(
        `expected 2 parts ('<publicIp>|<allocationId>'), got ${parts.length}: ${showRecordValue(physicalId)}. ` +
          `CloudFormation identifies an AWS::EC2::EIP by BOTH fields, and neither can be ` +
          `recovered from the other; re-deploy the resource to refresh state`
      );
    }
    const [first, second] = parts as [string, string];
    if (!first.trim() || !second.trim()) {
      throw new Error(`empty part in '<publicIp>|<allocationId>': ${showRecordValue(physicalId)}`);
    }
    // Bind by SHAPE, not by position. `eipPhysicalId` writes publicIp first and
    // every writer goes through it, but that ordering is the ONE thing here
    // nobody has verified against a state record in the wild — and a positional
    // bind turns a reversed record into `{PublicIp: 'eipalloc-…',
    // AllocationId: '52.1.2.3'}`, which CFn answers with an opaque
    // changeset-create failure instead of anything a user can act on. The two
    // segment shapes are disjoint and unmistakable (an allocation id is
    // `eipalloc-…`; a public IP is a dotted quad), so discriminating costs
    // nothing and removes the dependency on the order entirely.
    const allocationFirst = first.startsWith(EIP_ALLOCATION_ID_PREFIX);
    const publicIp = allocationFirst ? second : first;
    const allocationId = allocationFirst ? first : second;
    // BOTH halves are checked, not just the allocation id: `eipalloc-a|eipalloc-b`
    // satisfies an allocation-id-only guard and then ships
    // `PublicIp: 'eipalloc-b'` — the very opaque changeset failure the shape
    // bind exists to prevent. A discriminator that validates one side only is
    // not a discriminator.
    if (
      !allocationId.startsWith(EIP_ALLOCATION_ID_PREFIX) ||
      !EIP_PUBLIC_IP_PATTERN.test(publicIp)
    ) {
      throw new Error(
        `${showRecordValue(physicalId)} is not an '<publicIp>|<allocationId>' pair: CloudFormation identifies ` +
          `an AWS::EC2::EIP by [PublicIp, AllocationId], so one segment must be an allocation ` +
          `id ('${EIP_ALLOCATION_ID_PREFIX}…') and the other a dotted-quad public IP. State ` +
          `entry may be corrupt or written by an older cdkd binary; re-deploy the resource to ` +
          `refresh state`
      );
    }
    return {
      resourceIdentifier: { PublicIp: publicIp, AllocationId: allocationId },
      propertiesOverlay: {},
    };
  },
  // cdkd's SDK provider stores the BARE `deploymentId` (apigateway-provider.ts's
  // `createDeployment`); the Cloud Control path stores `deploymentId|restApiId`.
  // CFn primary identifier is [DeploymentId, RestApiId] with `DeploymentId`
  // read-only, so the overlay narrows to `RestApiId` (issue #1692).
  'AWS::ApiGateway::Deployment': restApiChildSplitter({
    resourceType: 'AWS::ApiGateway::Deployment',
    childField: 'DeploymentId',
    childFirstInCompositeId: true,
    narrowOverlayToRestApiId: true,
  }),
  // cdkd's SDK provider stores the BARE `stageName` (apigateway-provider.ts's
  // `createStage`); the Cloud Control path stores `restApiId|stageName`.
  // CFn primary identifier is [RestApiId, StageName] and the type has NO
  // read-only properties (live `DescribeType`, us-east-1, 2026-08-12), so the
  // default whole-map overlay is correct — `StageName` is a writable Property
  // the synth template already carries (issue #1692).
  'AWS::ApiGateway::Stage': restApiChildSplitter({
    resourceType: 'AWS::ApiGateway::Stage',
    childField: 'StageName',
    childFirstInCompositeId: false,
    narrowOverlayToRestApiId: false,
  }),
  // cdkd's SDK provider stores the BARE `authorizerId` (apigateway-provider.ts's
  // `createAuthorizer`); the Cloud Control path stores `restApiId|authorizerId`.
  // CFn primary identifier is [RestApiId, AuthorizerId] with `AuthorizerId`
  // read-only, so the overlay narrows to `RestApiId` (issue #1692).
  'AWS::ApiGateway::Authorizer': restApiChildSplitter({
    resourceType: 'AWS::ApiGateway::Authorizer',
    childField: 'AuthorizerId',
    childFirstInCompositeId: false,
    narrowOverlayToRestApiId: true,
  }),
  // cdkd has no SDK provider for this type, so it always routes through Cloud
  // Control, which stores `restApiId|name`. The bare form is still accepted so
  // a future SDK provider needs no state migration. CFn primary identifier is
  // [RestApiId, Name] and the type has NO read-only properties (live
  // `DescribeType`, us-east-1, 2026-08-12), so the default overlay is correct
  // — `Name` is a writable Property (issue #1692).
  'AWS::ApiGateway::Model': restApiChildSplitter({
    resourceType: 'AWS::ApiGateway::Model',
    childField: 'Name',
    childFirstInCompositeId: false,
    narrowOverlayToRestApiId: false,
  }),
  // cdkd has no SDK provider for this type either, so it routes through Cloud
  // Control, which stores `restApiId|requestValidatorId`. CFn primary
  // identifier is [RestApiId, RequestValidatorId] with `RequestValidatorId`
  // read-only, so the overlay narrows to `RestApiId` (issue #1692).
  'AWS::ApiGateway::RequestValidator': restApiChildSplitter({
    resourceType: 'AWS::ApiGateway::RequestValidator',
    childField: 'RequestValidatorId',
    childFirstInCompositeId: false,
    narrowOverlayToRestApiId: true,
  }),
  // cdkd stores just `IntegrationId` (apigatewayv2-provider.ts); the parent
  // `ApiId` lives in cdkd state's properties (`properties.ApiId`). CFn primary
  // identifier is [ApiId, IntegrationId]. ApiId IS a writable Property
  // (already in synth template via Ref); IntegrationId is tagged
  // `readOnlyProperties: ['/properties/IntegrationId']` in the CFn schema —
  // exclude it from propertiesOverlay so CFn doesn't reject writing a
  // read-only property at changeset-create.
  'AWS::ApiGatewayV2::Integration': (physicalId, properties) => {
    const apiId = readStringProperty(properties, 'ApiId', 'AWS::ApiGatewayV2::Integration');
    return {
      resourceIdentifier: { ApiId: apiId, IntegrationId: physicalId },
      propertiesOverlay: { ApiId: apiId },
    };
  },
  // cdkd stores just `RouteId` (apigatewayv2-provider.ts); parent `ApiId`
  // comes from properties. CFn primary identifier is [ApiId, RouteId]. Same
  // overlay narrowing as Integration above.
  'AWS::ApiGatewayV2::Route': (physicalId, properties) => {
    const apiId = readStringProperty(properties, 'ApiId', 'AWS::ApiGatewayV2::Route');
    return {
      resourceIdentifier: { ApiId: apiId, RouteId: physicalId },
      propertiesOverlay: { ApiId: apiId },
    };
  },
  // cdkd stores `<tableBucketARN>|<namespaceName>` (s3-tables-provider.ts's
  // `createNamespace`); CFn primary identifier is [TableBucketARN, Namespace] —
  // same order. Both fields are writable Properties the synth template already
  // carries (live `DescribeType`, us-east-1, 2026-08-13:
  // `readOnlyProperties` absent entirely, both fields `createOnlyProperties`
  // and `required`, both plain strings), so the default whole-map overlay is
  // correct and no narrowing is needed.
  //
  // Registered while live-testing issue #1659: without it, `cdkd export` aborts
  // on EVERY S3 Tables stack with "composite primary identifier (2 fields:
  // TableBucketARN, Namespace)", because CDK's `CfnTable` requires a namespace
  // and the namespace is its own resource. That made the sibling
  // `AWS::S3Tables::Table` identifier fix in this same change unreachable in
  // practice — a table cannot be exported without its namespace in the plan.
  //
  // `Namespace` is a STRING on both sides — measured 2026-08-13, because
  // `s3-tables-provider.ts` carried a comment claiming the CFn schema types it
  // `List<String>` (corrected in the same change as this note, issue #1771)
  // while that provider tolerates both wire shapes:
  //   - live `DescribeType`: `definitions.Namespace = {"type": "string"}`;
  //   - `aws-cdk-lib` 2.244.0 `CfnNamespaceProps.namespace: string`, and a
  //     synth of the typed prop emits `"Namespace": "analytics"`.
  // So the whole-map overlay below is right for every template CDK's typed API
  // can produce.
  //
  // An ARRAY is still REACHABLE, via `addPropertyOverride('Namespace', [...])`
  // (measured: it synthesizes `"Namespace": ["analytics"]`), and cdkd deploys
  // it because the provider accepts both. Such a template is not valid
  // CloudFormation — the registry types the property `string`, so CFn would
  // reject it on a plain CREATE too. The `resourceIdentifier` this splitter
  // builds is correct either way (it comes from the physicalId, not the
  // template), and since issue #1787 the shared overlay rule handles the
  // template side too: `overlayResourceIdentifierOnProperties` now overwrites
  // any literal — `["analytics"]` included — with the scalar identifier, and
  // refuses only a list carrying an intrinsic. So the array no longer survives
  // into the phase-1 template, and CFn no longer answers with an opaque
  // changeset-create rejection.
  'AWS::S3Tables::Namespace': (physicalId) => {
    const parts = physicalId.split('|');
    if (parts.length !== 2) {
      throw new Error(
        `expected 2 parts ('<tableBucketARN>|<namespaceName>'), got ${parts.length}: ${showRecordValue(physicalId)}`
      );
    }
    const [tableBucketARN, namespace] = parts as [string, string];
    if (!tableBucketARN || !namespace) {
      throw new Error(
        `empty part in '<tableBucketARN>|<namespaceName>': ${showRecordValue(physicalId)}`
      );
    }
    return { resourceIdentifier: { TableBucketARN: tableBucketARN, Namespace: namespace } };
  },
  // cdkd's SDK provider stores the BARE `StageName` (apigatewayv2-provider.ts's
  // `createStage`) and reads the parent `ApiId` from the recorded properties;
  // a Stage created or imported through Cloud Control stores CC's `|`-joined
  // identifier, `<apiId>|<stageName>` (the intrinsic resolver decodes the same
  // two shapes). Both are accepted. A stage name cannot contain `|`.
  //
  // CFn primary identifier is [ApiId, StageName], `ProvisioningType:
  // FULLY_MUTABLE` with a `read` handler, and NO `readOnlyProperties` (live
  // `DescribeType`, us-east-1), so the default whole-map overlay is right:
  // both fields are writable Properties the synth template already carries.
  //
  // This type used to be pre-deleted and re-CREATEd in phase 2, because
  // CloudFormation once refused it in IMPORT changesets; AWS's import-support
  // table now lists it as importable, so an HttpApi's `$default` stage is
  // imported in place with no unavailability window (issue
  // [#1772](https://github.com/go-to-k/cdkd/issues/1772)).
  'AWS::ApiGatewayV2::Stage': (physicalId, properties) => {
    if (!physicalId.trim()) {
      throw new Error('empty physical id for AWS::ApiGatewayV2::Stage (expected a StageName)');
    }
    const parts = physicalId.split('|');
    if (parts.length > 2) {
      throw new Error(
        `expected a bare StageName or '<apiId>|<stageName>', got ${parts.length} parts: ` +
          `${showRecordValue(physicalId)}`
      );
    }
    if (parts.length === 2) {
      const [apiId, stageName] = parts as [string, string];
      if (!apiId || !stageName) {
        throw new Error(`empty part in '<apiId>|<stageName>': ${showRecordValue(physicalId)}`);
      }
      return { resourceIdentifier: { ApiId: apiId, StageName: stageName } };
    }
    const apiId = readStringProperty(properties, 'ApiId', 'AWS::ApiGatewayV2::Stage');
    return { resourceIdentifier: { ApiId: apiId, StageName: physicalId } };
  },

  // cdkd stores `<functionName>|<qualifier>` (lambda-event-invoke-config-
  // provider.ts's `buildPhysicalId`), split on the FIRST `|` — a Lambda function
  // name is `[a-zA-Z0-9-_]+` and a function ARN carries no `|`, which is the
  // premise `parsePhysicalId` documents and `packCompositeId` enforces. A BARE
  // function name is accepted and read as qualifier `$LATEST`, mirroring that
  // same `parsePhysicalId` (and CFn's own default for the unqualified config).
  //
  // CFn primary identifier is [FunctionName, Qualifier] — same order — and the
  // type declares NO `readOnlyProperties` at all (live `DescribeType`,
  // us-east-1, 2026-08-13; both fields are `required` + `createOnlyProperties`),
  // so the default whole-map overlay is correct: both are writable Properties
  // the synth template already carries, and writing them is what keeps CFn's
  // identifier-match check satisfied (issue #1771).
  'AWS::Lambda::EventInvokeConfig': (physicalId) => {
    if (!physicalId.trim()) {
      throw new Error(
        'empty physical id for AWS::Lambda::EventInvokeConfig ' +
          "(expected '<functionName>|<qualifier>' or a bare function name)"
      );
    }
    const separator = physicalId.indexOf('|');
    if (separator === -1) {
      return { resourceIdentifier: { FunctionName: physicalId, Qualifier: '$LATEST' } };
    }
    const functionName = physicalId.slice(0, separator);
    const qualifier = physicalId.slice(separator + 1);
    // `.trim()`, not truthiness: `'  |  '` clears the whole-id blank guard above
    // (it is not blank once split) and would otherwise ship
    // `FunctionName: '  '` into the changeset. Note the ApiGateway-family
    // splitters trim the WHOLE id only, not each segment — this is the stricter
    // per-segment check, matching `AWS::EC2::Route` / `AWS::EC2::EIP`.
    if (!functionName.trim() || !qualifier.trim()) {
      throw new Error(`empty part in '<functionName>|<qualifier>': ${showRecordValue(physicalId)}`);
    }
    return { resourceIdentifier: { FunctionName: functionName, Qualifier: qualifier } };
  },
  // cdkd stores `StatementId` (lambda-permission-provider.ts:124); for state
  // entries written by the older CC-API path (pre-SDK-provider), physicalId
  // may instead be the legacy `<functionArn>|<statementId>` shape — the
  // provider's own delete / update / getAttribute paths normalize via
  // `physicalId.split('|').pop()` (see lambda-permission-provider.ts:160 /
  // 222 / 290). Mirror that here so legacy state still produces the
  // correct CFn Id field; otherwise CFn IMPORT's identifier-match would
  // compare `Id: '<arn>|<sid>'` against the AWS-current Sid and reject.
  //
  // CFn primary identifier is [FunctionName, Id] (note: CFn schema calls
  // the field `Id`, not `StatementId`). FunctionName IS a writable
  // Property; `Id` is tagged `readOnlyProperties: ['/properties/Id']` in
  // the CFn schema (it's set at create time by AWS, not by the user).
  // Narrow overlay to FunctionName so CFn doesn't reject writing read-only
  // `Id` at changeset-create.
  'AWS::Lambda::Permission': (physicalId, properties) => {
    const functionName = readStringProperty(properties, 'FunctionName', 'AWS::Lambda::Permission');
    const statementId = physicalId.includes('|') ? physicalId.split('|').pop()! : physicalId;
    return {
      resourceIdentifier: { FunctionName: functionName, Id: statementId },
      propertiesOverlay: { FunctionName: functionName },
    };
  },
  // Issue #3414. AWS re-published the type on 2026-09-18 as `FULLY_MUTABLE`
  // with a full handler set (it had no `handlers` block and was
  // NON_PROVISIONABLE when `typeIsImportUnsupported` was measured, so the
  // pre-flight used to refuse it before the identifier was ever resolved) and
  // a COMPOSITE primaryIdentifier `[ApiId, ApiKeyId]` where it had been the
  // single `ApiKeyId`. With the refusal gone, a stack carrying a key reached
  // the "add an entry to COMPOSITE_ID_SPLITTERS" throw below.
  //
  // Three id shapes reach this splitter, and all three are decoded because a
  // refusal here blocks the WHOLE export:
  //   1. `<apiId>|<apiKeyId>` — what `AppSyncProvider.createApiKey` packs
  //      (`packCompositeId`, same order as the new CFn identifier) AND what the
  //      Cloud Control route stores now that the identifier is composite;
  //   2. the key ARN `arn:<partition>:appsync:<region>:<account>:apis/<apiId>/apikeys/<apiKeyId>`
  //      — CloudFormation's `Ref` for the type (plural `apikeys`, measured in
  //      #5540; the singular `apikey` the CFn docs print is accepted too), so the
  //      `PhysicalResourceId` a `--migrate-from-cloudformation` import before
  //      #5364 recorded verbatim;
  //   3. the bare `<apiKeyId>` — what `cdkd import --resource Key=<apiKeyId>`
  //      records verbatim (`AppSyncProvider.import` stores `knownPhysicalId` as
  //      given for every child type); the parent comes from the recorded
  //      `ApiId` property, the way `AWS::ApiGateway::Resource`'s bare form
  //      recovers `RestApiId`. NOT a Cloud Control shape: the type was
  //      NON_PROVISIONABLE before the flip, so CC never wrote a bare id.
  // `ApiKeyId` is `readOnlyProperties`, so the overlay narrows to `ApiId` —
  // writing the read-only field into Properties is rejected at changeset-create.
  // Both segments are AWS-minted ids, so a `|` inside one cannot occur and the
  // arity test is exact rather than "at least". An `arn:`-prefixed value that
  // is NOT the key ARN shape above is refused rather than shipped as a bare
  // key id — a mis-spelled ARN (a wrong segment or service) has no `|`, so
  // without the guard it would fall through to shape 3 and only CreateChangeSet
  // would notice.
  'AWS::AppSync::ApiKey': (physicalId, properties) => {
    const trimmed = physicalId.trim();
    if (!trimmed) {
      throw new Error(
        "empty physical id for AWS::AppSync::ApiKey (expected 'apiId|apiKeyId', the key ARN, or a bare apiKeyId)"
      );
    }
    const arnMatch = /^arn:[^:]+:appsync:[^:]*:[^:]*:apis\/([^/|]+)\/apikeys?\/([^/|]+)$/.exec(
      trimmed
    );
    if (arnMatch) {
      const [, apiId, apiKeyId] = arnMatch as unknown as [string, string, string];
      return {
        resourceIdentifier: { ApiId: apiId, ApiKeyId: apiKeyId },
        propertiesOverlay: { ApiId: apiId },
      };
    }
    if (trimmed.startsWith('arn:')) {
      throw new Error(
        `${showRecordValue(physicalId)} looks like an ARN but is not an AppSync API key ARN ` +
          `(expected arn:<partition>:appsync:<region>:<account>:apis/<apiId>/apikeys/<apiKeyId>)`
      );
    }
    const parts = trimmed.split('|');
    if (parts.length > 2) {
      throw new Error(
        `expected 'apiId|apiKeyId', the key ARN, or a bare apiKeyId, got ${parts.length} parts: ${showRecordValue(physicalId)}`
      );
    }
    if (parts.length === 2) {
      const [apiId, apiKeyId] = parts as [string, string];
      if (!apiId.trim() || !apiKeyId.trim()) {
        throw new Error(`empty part in 'apiId|apiKeyId': ${showRecordValue(physicalId)}`);
      }
      return {
        resourceIdentifier: { ApiId: apiId, ApiKeyId: apiKeyId },
        propertiesOverlay: { ApiId: apiId },
      };
    }
    const apiId = readStringProperty(properties, 'ApiId', 'AWS::AppSync::ApiKey');
    return {
      resourceIdentifier: { ApiId: apiId, ApiKeyId: trimmed },
      propertiesOverlay: { ApiId: apiId },
    };
  },
};

/**
 * Returns true if cdkd has a registered splitter for the given type. Used
 * by `resolveResourceIdentifier` to decide between the single-key and
 * composite paths, and by tests to assert coverage.
 */
export function hasCompositeIdSplitter(resourceType: string): boolean {
  return Object.prototype.hasOwnProperty.call(COMPOSITE_ID_SPLITTERS, resourceType);
}

/**
 * Exported for unit tests — apply the registered splitter for `resourceType`
 * to `physicalId` (with the resource's recorded properties for splitters
 * that need a parent identifier from state) and return the resulting
 * `CompositeIdResult`. Throws when no splitter is registered (same shape
 * as `resolveResourceIdentifier`'s composite path).
 */
export function splitCompositePhysicalId(
  resourceType: string,
  physicalId: string,
  properties: Record<string, unknown> = {}
): CompositeIdResult {
  // `Object.hasOwn`, not a bare index: an object literal answers for inherited
  // members too, so a resourceType of `constructor` / `toString` would resolve to
  // a FUNCTION here and fail somewhere confusing downstream instead of at this
  // not-registered check. Mirrors the `has*` predicates above.
  const splitter = Object.hasOwn(COMPOSITE_ID_SPLITTERS, resourceType)
    ? COMPOSITE_ID_SPLITTERS[resourceType]
    : undefined;
  if (!splitter) {
    throw new Error(`no composite-id splitter registered for ${resourceType}`);
  }
  return splitter(physicalId, properties);
}
