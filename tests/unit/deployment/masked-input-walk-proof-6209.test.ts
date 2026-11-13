import { describe, it, expect, vi } from 'vite-plus/test';
import {
  maskedInputBinding,
  maskedInputFingerprint,
  parameterInputsFor,
  type MaskedInputSources,
} from '../../../src/deployment/masked-property-fingerprints.js';
import { inputForm, newWalk } from '../../../src/deployment/masked-property-fingerprints/input-walk.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * go-to-k/cdkd#6209: the #4543 input walk also reports whether every input of
 * a value was resolved and hashed (`proven`). The walk is shared with the
 * diff and the masked-property skip, so its `form`, `concrete` flag and
 * fingerprint must stay byte-identical whatever the proof says.
 */
const TEMPLATE: CloudFormationTemplate = {
  Parameters: {
    Plain: { Type: 'String' },
    Hidden: { Type: 'String', NoEcho: true },
    Other: { Type: 'String', NoEcho: true },
    Token: { Type: 'String' },
    Env: { Type: 'String' },
  },
  Conditions: {
    IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] },
    HiddenSet: { 'Fn::Equals': [{ Ref: 'Hidden' }, 'x'] },
  },
  Mappings: { M: { a: { b: 'mapped' } } },
  Resources: {
    Fn: { Type: 'AWS::Lambda::Function', Properties: { FunctionName: 'f' } },
    Tainted: { Type: 'AWS::S3::Bucket', Properties: { BucketName: { Ref: 'Hidden' } } },
    Custom: { Type: 'Custom::Thing', Properties: { ServiceToken: 'arn:x' } },
  },
};

const RESOLVED: Record<string, unknown> = {
  [JSON.stringify({ Ref: 'Fn' })]: 'f',
  [JSON.stringify({ 'Fn::GetAtt': ['Fn', 'Arn'] })]: 'arn:aws:lambda:us-east-1:1:function:f',
  [JSON.stringify({ Ref: 'AWS::Region' })]: 'us-east-1',
  [JSON.stringify({ 'Fn::ImportValue': 'Shared' })]: 'imported',
  [JSON.stringify({ 'Fn::FindInMap': ['M', 'a', 'b'] })]: 'mapped',
};

function sources(resolved: Record<string, unknown> = RESOLVED): MaskedInputSources {
  const { parameterInput } = parameterInputsFor({
    template: TEMPLATE,
    values: {
      Plain: 'p',
      Hidden: 'hidden-value',
      Other: 'other-value',
      Token: '{{resolve:ssm:/t}}',
      Env: 'dev',
    },
  });
  return {
    template: TEMPLATE,
    parameterInput,
    conditions: { IsProd: false, HiddenSet: false },
    resolve: vi.fn((node: unknown) => {
      const key = JSON.stringify(node);
      if (!Object.hasOwn(resolved, key)) return Promise.reject(new Error('unresolvable'));
      return Promise.resolve({ value: resolved[key] });
    }),
  };
}

const getAtt = { 'Fn::GetAtt': ['Fn', 'Arn'] };

/** Each value with whether it is proven when `Hidden` is covered by a MAC. */
const CORPUS: Array<[string, unknown, boolean]> = [
  ['a literal', 'text', true],
  ['a plain parameter', { Ref: 'Plain' }, true],
  ['a covered NoEcho parameter', { Ref: 'Hidden' }, true],
  ['an uncovered NoEcho parameter', { Ref: 'Other' }, false],
  ['a parameter carrying a reference', { Ref: 'Token' }, false],
  ['AWS::NoValue', { Ref: 'AWS::NoValue' }, true],
  ['a pseudo parameter', { Ref: 'AWS::Region' }, true],
  ['a resource Ref', { Ref: 'Fn' }, true],
  ['a GetAtt', getAtt, true],
  ['a GetAtt on a secret-reading resource', { 'Fn::GetAtt': ['Tainted', 'Arn'] }, false],
  ['a GetAtt on a custom resource', { 'Fn::GetAtt': ['Custom', 'Out'] }, false],
  ['a GetAtt on an undeclared resource', { 'Fn::GetAtt': ['Nope', 'Arn'] }, false],
  ['an undeclared name', { Ref: 'Nope' }, false],
  // Compared as its token, as CloudFormation compares it.
  ['a standalone dynamic reference', '{{resolve:ssm:/x}}', true],
  ['a joined dynamic reference', { 'Fn::Join': ['', ['{{resolve:ssm:/x}}', { Ref: 'Plain' }]] }, false],
  ['a Sub map dynamic reference', { 'Fn::Sub': ['${A}', { A: '{{resolve:ssm:/x}}' }] }, false],
  [
    'an object with a standalone reference beside a GetAtt',
    { a: '{{resolve:ssm:/x}}', b: getAtt, c: { Ref: 'Hidden' } },
    true,
  ],
  [
    'a Body with a covered NoEcho value and a GetAtt',
    {
      paths: {
        '/a': { uri: { 'Fn::Sub': 'arn:aws:apigateway:${AWS::Region}:lambda:path/${Fn.Arn}' } },
      },
      key: { Ref: 'Hidden' },
      join: { 'Fn::Join': ['', ['k=', { Ref: 'Hidden' }, ';', getAtt]] },
    },
    true,
  ],
  ['a Sub with a covered placeholder', { 'Fn::Sub': '${Hidden}-${Plain}' }, true],
  ['a Sub with an uncovered placeholder', { 'Fn::Sub': '${Other}-${Plain}' }, false],
  ['a Sub with a custom attribute', { 'Fn::Sub': '${Custom.Out}' }, false],
  ['a Sub with a variable map', { 'Fn::Sub': ['${X}', { X: { Ref: 'Hidden' } }] }, true],
  ['a Sub text carrying a reference', { 'Fn::Sub': '{{resolve:ssm:/x}}${Plain}' }, false],
  ['a known condition', { 'Fn::If': ['IsProd', { Ref: 'Other' }, { Ref: 'Hidden' }] }, true],
  ['a secret condition', { 'Fn::If': ['HiddenSet', 'a', 'b'] }, false],
  ['a cross-stack read', { 'Fn::ImportValue': 'Shared' }, true],
  ['a cross-stack read named by a NoEcho value', { 'Fn::ImportValue': { Ref: 'Hidden' } }, false],
  ['a mapping read', { 'Fn::FindInMap': ['M', 'a', 'b'] }, true],
  ['a pure intrinsic', { 'Fn::Base64': { 'Fn::Join': ['', [{ Ref: 'Hidden' }, 'x']] } }, true],
  ['a pure intrinsic over a kept input', { 'Fn::Base64': { 'Fn::Join': ['', [{ Ref: 'Other' }, 'x']] } }, false],
  ['an attribute name built from a NoEcho value', { 'Fn::GetAtt': ['Fn', { Ref: 'Hidden' }] }, false],
  ['an array', [{ Ref: 'Hidden' }, { Ref: 'Plain' }, getAtt], true],
  ['an array with one kept input', [{ Ref: 'Hidden' }, { Ref: 'Other' }], false],
  ['an object with one kept input', { a: { Ref: 'Hidden' }, b: { Ref: 'Other' } }, false],
  ['a Sub variable map with a kept input', { 'Fn::Sub': ['${X}', { X: { Ref: 'Other' } }] }, false],
];

/**
 * What the walk produced BEFORE go-to-k/cdkd#6209 (captured from the
 * unchanged tree): the fingerprint of each corpus value. A difference here is
 * a change to the diff's and the masked-property skip's comparison.
 */
const GOLDEN: Record<string, string> = {
  "a literal":
    'inputs-sha256:602a1fd3492256e63aa46453b7f0b629e2ea366dba626ab20b3e2f1bfc4bef22+sha256:024c423e5cf70e3a487ebb3501b24118b6ab1a6b5a4a04d9b9cdf69c96fcbea4',
  "a plain parameter":
    'inputs-sha256:4dd40368610b1051d3b255ab1acbeb33728b18bcdeb32929c59be2db42d6b109+sha256:6da084eb18ecd5eeaff81b57de7722db6f49e62a69b92e75e22bdd8f49a27f08',
  "a covered NoEcho parameter":
    'inputs-sha256:ece717560c552ab4b313bfe2d3a18e7b30687428955c2ceeb69c4d623b75b15a+sha256:83c00e3ad698cb2ebd5cddd5321619567dd15343878bcb87eadf691a9af03f33',
  "an uncovered NoEcho parameter":
    'inputs-sha256:210ea6670ed192e8ac80413ebde2adece36070f2014b4dd43adf7201ae199a78+sha256:5746da444137a04b888f7fd54ba1d8e89b13df66312fa316de811a76fd557601',
  "a parameter carrying a reference":
    'inputs-sha256:fa28715ce83b13dbb833571d7f2a4d6e0375c481fd85dcbaa0f1cc613a71907e+sha256:e7d4126d6fee41e65de36a828671217c62af02031298b370004f4aea17f88ff9',
  "AWS::NoValue":
    'inputs-sha256:12e03811d9a57cd3becfe4270c4c3165974820279b215ed50494dbfb1ddde478+sha256:875a7028eb0f27dd2f49fa3ac2fa5f116f1a537e87a1fcef2e3e841c8c375c89',
  "a pseudo parameter":
    'inputs-sha256:4f06fd92289f72eea38ee3c62784f8abdcd58c43f928b61638aa1ec32c3ef1f2+sha256:3acfaaaafb60f2e19aa7538cf28335d549ffcc6819979fdef60c4b3841ac0a1b',
  "a resource Ref":
    'inputs-sha256:ad0134038a193e115b916eed65477cb289b77c5fd132e7ae8156a2fcb47fb1b7+sha256:579f850b2b7958841de3cfb1809b2f964de33275be59a11abfaa86a762e89a6f',
  "a GetAtt":
    'inputs-sha256:175f2722e0429f17302ea9cd14d93780cca5c609756a7629ff4e014e15c33bb9+sha256:c0b31cc23cc56a4f9f8f74c6b6ec2dda2054c1c270c889bf1359972aaf0d717d',
  "a GetAtt on a secret-reading resource":
    'inputs-sha256:0b4f645db07abd943b188e87469c5233d5c0cd09a617da036a44c586b41f852f+sha256:30cee08760f83e4f3b7cbc38f67187e00e68380a898d681fea428f4eea218010',
  "a GetAtt on a custom resource":
    'inputs-sha256:40719eef69fb67608d9a6ea90b1b65bf30db7db3aa2d681e8f5c83178e5924ab+sha256:4cfd8d00acf07a2d5051484492392e779efb744b2304d5fbaf1c9f3c309e5aa9',
  "a GetAtt on an undeclared resource":
    'inputs-sha256:46d46bd246618bbc88792526e31358808e265e3f3f5d5a711e74be8fa01feac1+sha256:ed87a7a495757a73afd0b9b79b75b8da35c8eb37e0c61cc0c20db9d6dc4b9eac',
  "an undeclared name":
    'inputs-sha256:ee515730c6378d06f2b25574ddd491027cb17ac4089eb1ceab7a44b6b01f1695+sha256:2fc69991f162c0737dd970585b4419f85db6840d960c635bbd7ffdb15bc5fc72',
  "a standalone dynamic reference":
    'inputs-sha256:ea4577cfb99842ad56b3aa11610efe5cb4624ad33c178b3589e64e193ed3cdda+sha256:dca4146cb7c768c67ce616abce7ee1a14a38e9b513194d60a136b25fada32f10',
  "a Body with a covered NoEcho value and a GetAtt":
    'inputs-sha256:6442d5027e08e3895a73a54a204eeb9f1a7c21591e7688ce29b66aefcfdc0666+sha256:c32d3acff46013196a6d0d34c55b75e1431d5d5f5117f3908794a761ba3557e0',
  "a Sub with a covered placeholder":
    'inputs-sha256:85dc5ddc4cff104c53f3500231427546baece34c0cef9487b5ff4525f51ea5dc+sha256:037fee2a0983a4a0c7cfdcefcd002e093c5406d0e0c4291e704b29c3dcb57f16',
  "a Sub with an uncovered placeholder":
    'inputs-sha256:deacda7aebd413394d6af8f72559a17a13041c505e32dc99cba6597b32ce0f4e+sha256:b1b9ce6910b16f88b6ba98d8181fa72b9a416a46f36e8793a16ad5eed3716e2a',
  "a Sub with a custom attribute":
    'inputs-sha256:dba8b0403ca5f954d076023c96602ee38175eb3dfc369991e7119064f45f26a1+sha256:dd6f368a227d6dc5bb8b0e867774567870173acc07af5f85b99b51adfcf7a36b',
  "a Sub with a variable map":
    'inputs-sha256:1e3eebc1c4ddd871c427f8038ec81a10654315d444600c2113da6e6a244fd068+sha256:fbac3c0e81d5e7067a9c9b3b75fcb15f20a3cb34fa21d6ff6cd8a604d85216d2',
  "a Sub text carrying a reference":
    'inputs-sha256:3554b9295b79ce6a3f5fddbfdce4cf6a588de420e0906e7a3a77043b5ade48d5+sha256:043244a80a86efc2ca1a6342a6bf62a16f9b6e6664353e1ce419441cddead1b9',
  "a known condition":
    'inputs-sha256:ece717560c552ab4b313bfe2d3a18e7b30687428955c2ceeb69c4d623b75b15a+sha256:bca215cde72f20ad6141a1c5dafa88e14280630a7814a374ee4bc1017f557add',
  "a secret condition":
    'inputs-sha256:4157806db38ef7fd2e8ff1ae685d8705bd97a085bf114c789613c0f289645e3d+sha256:dc2bc031eacbafd68be9f7939490d7807eab9e33550dc485cad409de6aa7c6af',
  "a cross-stack read":
    'inputs-sha256:603b869388aef6680865fa0143bea0f2e0ad224d1b57920dd6a405f1b3a47e8e+sha256:4015b33d78d9a40bb095061c35392111e601edb0e8381d0da8ff7d202b727251',
  "a cross-stack read named by a NoEcho value":
    'inputs-sha256:d6331195d01c94d878dde275e4b9006e4acb9fe5188b9aa337e48910e5bd0953+sha256:34734aae576838d18f6e0a2b7c783f0de1f5dac6aee1b726f0a20ef78389745a',
  "a mapping read":
    'inputs-sha256:f9369cee33a9ca0eb6585d68362feafb24c46447eb009a537ae3a4d0c5b18f8b+sha256:3d347ed182260e1ed9291fc64dc0678a72cfc3bae06cbb2cf9efb36ff6c9cb78',
  "a pure intrinsic":
    'inputs-sha256:355d982587bb862f6a57552abd536a79b24cbd22f2ba43fb86a003b35a31e932+sha256:b2c2c979648620733d26ffb5442949dc54d181d771f458ceb75d646526b7f836',
  "a pure intrinsic over a kept input":
    'inputs-sha256:6a7b87ead0efbae5b780d9ec38e5cd5ae3e13ef3491ef990cd53ed9a67620824+sha256:a086a9de72148a70ec0ff3c83edb65b19be5059b81319bb86e8c54e6b78f4cd0',
  "a joined dynamic reference":
    'inputs-sha256:c87e6464e47b4ab6b107b4f941e39652d969123f29702029e8ccd42ca172abef+sha256:8b45a514e7a72b37cd0ec82c94cf3b177658ef190c960d9127bbd0bfef7d786e',
  "a Sub map dynamic reference":
    'inputs-sha256:089cae948aa6cf661d9cc16a2e612a146221cbf1fc6513026c462f15a1e2b776+sha256:f435c7bc31b7dce6a8b5ad5631364b1d5437200b1666b32aa34a58cbd3501f0a',
  "an object with a standalone reference beside a GetAtt":
    'inputs-sha256:e78db2b999c450076eccd07194bfbeb94cb2d358a8c6903661f9f8a87292b109+sha256:eb201baf49c84a06d6e60d435138701c1ac14ca4a8f3fbdd3c1110451869bd32',
  "an attribute name built from a NoEcho value":
    'inputs-sha256:8c06a4b961460fade38687efaf6f56ec7499567355d3fc2e01e59a5d403968a1+sha256:0c0451357392a0b4432219301dcff30ec511ef28bffb124f2bdadaeb03c7ad30',
  "an array":
    'inputs-sha256:9d20957aedd9b8d2038233a0116fe67335ab1f775657e50b70b9a601805ce976+sha256:a94b748e9da662b3d63251adffdf4093330be3b0f9621cb348446d8d507640b2',
  "an object with one kept input":
    'inputs-sha256:25647e4b193103d6d45338c6392dd693ded96916ce33c82d48bf01fde45cd2e8+sha256:a6be970271ee71b193a1c4daabd5cd15ee362b792bcac76090d16e3bbfd7ec1e',
  "a Sub variable map with a kept input":
    'inputs-sha256:8d75cd3737a4f9efc02520c5915a336308e36472ec432052e4cab6148137a0b0+sha256:9a2ce237c349e1d2680d85b7db490b880cc7140a0ca8c327daf7fb4381461129',
  "an array with one kept input":
    'inputs-sha256:117a6d65b0f151e5fcb5fbdd9c35572383e1fd28d29a02ba6d7015534dc47ab1+sha256:81e867a3a604de2bc878580800613990b606c29def8df3e08427612f191b4e35',
};

describe('the input walk with and without a MAC cover (go-to-k/cdkd#6209)', () => {
  it.each(CORPUS)('%s: the form and concrete flag do not depend on the cover', async (_, value) => {
    const plain = await inputForm(value, newWalk(sources()));
    const covered = await inputForm(value, newWalk(sources(), undefined, new Set(['Hidden'])));
    expect(covered.form).toEqual(plain.form);
    expect(covered.concrete).toBe(plain.concrete);
    // A walk without a cover computes no proof at all (the diff's and the
    // masked-property skip's walks pay nothing for it).
    expect('proven' in plain).toBe(false);
  });

  it.each(CORPUS)('%s: the fingerprint is the one the walk gave before', async (name, value) => {
    expect(await maskedInputFingerprint(value, sources())).toBe(GOLDEN[name]);
  });

  it.each(CORPUS)(
    '%s: a binding exists exactly when every input is resolved or covered, and is the fingerprint',
    async (name, value, proven) => {
      const binding = await maskedInputBinding(value, sources(), new Set(['Hidden']));
      expect(binding).toBe(proven ? GOLDEN[name] : undefined);
    }
  );

  it('with no cover, a NoEcho parameter is never proof', async () => {
    expect(await maskedInputBinding({ Ref: 'Hidden' }, sources(), new Set())).toBeUndefined();
    expect(await maskedInputBinding(getAtt, sources(), new Set())).toBe(GOLDEN['a GetAtt']);
  });

  it('an input this side cannot read is no binding', async () => {
    expect(await maskedInputBinding(getAtt, sources({}), new Set(['Hidden']))).toBeUndefined();
  });

  it('the floor: the corpus holds both proven and unproven values', () => {
    expect(CORPUS.filter(([, , proven]) => proven).length).toBeGreaterThanOrEqual(10);
    expect(CORPUS.filter(([, , proven]) => !proven).length).toBeGreaterThanOrEqual(10);
  });
});
