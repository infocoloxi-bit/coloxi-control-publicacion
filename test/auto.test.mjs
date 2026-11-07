import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRelease,validateProvenance,validateDeployment,validateForward,selectAutoBuild,buildAutoRelease,validateSourcePR,REQUIRED_JOBS,BUILD_WORKFLOW} from '../scripts/policy.mjs';

const S='1'.repeat(40), PROD='2'.repeat(40), D='c'.repeat(64);
const build=()=>({id:101,head_sha:S,head_branch:'main',status:'completed',conclusion:'success',run_attempt:1,event:'workflow_dispatch',path:BUILD_WORKFLOW});
const ci=()=>({id:202,head_sha:S,head_branch:'main',status:'completed',conclusion:'success',event:'push',name:'verificar'});
const art=()=>({id:303,name:'web-approved-'+S,expired:false,digest:'sha256:'+D,workflow_run:{id:101,head_sha:S},size_in_bytes:1000});
const auto=()=>buildAutoRelease({build:build(),ci:ci(),artifact:art()});

test('auto: release derived from evidence is valid and carries no rollback/pin',()=>{const r=auto();assert.equal(r.mode,'auto');assert.equal(r.rollback_version,undefined);});
test('auto: newest valid build is selected, reruns and branches skipped',()=>{
  const b=[{...build(),run_attempt:2},{...build(),head_branch:'feature'},{...build(),path:'.github/workflows/otro.yml'},{...build(),id:99}];
  assert.equal(selectAutoBuild(b).id,99);assert.equal(selectAutoBuild([]),null);
});
for(const [name,mut] of [
  ['CI on other SHA',(x)=>x.ci.head_sha=PROD],['CI failed',(x)=>x.ci.conclusion='failure'],['CI from PR',(x)=>x.ci.event='pull_request'],
  ['CI from branch',(x)=>x.ci.head_branch='feature'],['missing CI',(x)=>x.ci=undefined],['artifact other run',(x)=>x.artifact.workflow_run.id=5],
  ['artifact expired',(x)=>x.artifact.expired=true],['artifact renamed',(x)=>x.artifact.name='web-approved-'+PROD],['missing artifact',(x)=>x.artifact=undefined],
])test('auto rejects '+name,()=>{const x={build:build(),ci:ci(),artifact:art()};mut(x);assert.throws(()=>buildAutoRelease(x));});
test('auto cannot smuggle bootstrap or rollback pins',()=>{
  assert.throws(()=>validateRelease({...auto(),bootstrap_evidence:true}));
  assert.throws(()=>validateRelease({...auto(),rollback_version:'5d981330-0822-4fc9-a779-9b71e5e10685'}));
  assert.throws(()=>validateRelease({...auto(),mode:'other'}));
});
test('auto provenance requires push CI on main and four jobs',()=>{
  const r=auto();const f={repo:{private:true},main:{object:{sha:S}},build:build(),ci:ci(),jobs:REQUIRED_JOBS.map(name=>({name,status:'completed',conclusion:'success'})),artifact:art()};
  assert.equal(validateProvenance(r,f),true);
  assert.throws(()=>validateProvenance(r,{...f,ci:{...ci(),event:'workflow_dispatch'}}));
  assert.throws(()=>validateProvenance(r,{...f,jobs:f.jobs.slice(1)}));
});
const vid='5d981330-0822-4fc9-a779-9b71e5e10685';
const dep={id:'881373ae-e632-4c69-bc40-8ba389866617',versions:[{version_id:vid,percentage:100}]};
test('auto deployment: current is no-write, controller-tagged production allows publish',()=>{
  assert.equal(validateDeployment(dep,{id:vid,annotations:{'workers/tag':S}},auto(),'auto'),'current');
  assert.equal(validateDeployment(dep,{id:vid,annotations:{'workers/tag':PROD}},auto(),'auto'),'publish');
});
test('auto deployment refuses foreign production, split traffic and mode mixing',()=>{
  assert.throws(()=>validateDeployment(dep,{id:vid,annotations:{}},auto(),'auto'));
  assert.throws(()=>validateDeployment({...dep,versions:[{version_id:vid,percentage:50}]},{id:vid,annotations:{'workers/tag':PROD}},auto(),'auto'));
  assert.throws(()=>validateDeployment(dep,{id:vid,annotations:{'workers/tag':PROD}},auto(),'publish'));
  assert.throws(()=>validateDeployment(dep,{id:vid,annotations:{'workers/tag':S}},auto(),'rollback'));
});
const cmp=()=>({status:'ahead',ahead_by:3,behind_by:0,base_commit:{sha:PROD},merge_base_commit:{sha:PROD},url:'https://api.github.com/repos/x/y/compare/'+PROD+'...'+S});
test('forward: candidate strictly ahead of production passes',()=>assert.equal(validateForward(auto(),PROD,cmp()),true));
for(const [name,mut] of [['downgrade',c=>{c.status='behind';c.ahead_by=0;c.behind_by=2;}],['diverged',c=>{c.status='diverged';c.behind_by=1;}],
  ['identical',c=>{c.status='identical';c.ahead_by=0;}],['other base',c=>c.merge_base_commit.sha='3'.repeat(40)],['other head',c=>c.url=c.url.replace(S,PROD)]])
  test('forward rejects '+name,()=>{const c=cmp();mut(c);assert.throws(()=>validateForward(auto(),PROD,c));});

test('source PR: PR ordinario autorizado puede publicarse', () => {
  const prs = [{ number: 116, merged_at: '2026-11-07T00:12:24Z', merge_commit_sha: S, base: { ref: 'main' } }];
  const res = validateSourcePR(S, prs);
  assert.equal(res.pr, 116);
  assert.equal(res.commit, S);
});

test('source PR: push directo sin autorizacion queda bloqueado', () => {
  assert.throws(() => validateSourcePR(S, []), /DIRECT_PUSH_DETECTED_NO_MERGED_PR/);
  assert.throws(() => validateSourcePR(S, [{ number: 99, merged_at: null, head: { sha: S } }]), /DIRECT_PUSH_DETECTED_NO_MERGED_PR/);
});

test('source PR: PR fusionado hacia otra rama queda bloqueado', () => {
  const prs = [{ number: 115, merged_at: '2026-11-07T00:00:00Z', merge_commit_sha: S, base: { ref: 'develop' } }];
  assert.throws(() => validateSourcePR(S, prs), /DIRECT_PUSH_DETECTED_NO_MERGED_PR/);
});

test('source PR: PR de main con SHA no coincidente queda bloqueado', () => {
  const prs = [{ number: 114, merged_at: '2026-11-07T00:00:00Z', merge_commit_sha: PROD, head: { sha: PROD }, base: { ref: 'main' } }];
  assert.throws(() => validateSourcePR(S, prs), /DIRECT_PUSH_DETECTED_NO_MERGED_PR/);
});

test('source PR: entrada invalida o no array queda bloqueada', () => {
  assert.throws(() => validateSourcePR(S, null), /DIRECT_PUSH_DETECTED_NO_MERGED_PR/);
  assert.throws(() => validateSourcePR(S, {}), /DIRECT_PUSH_DETECTED_NO_MERGED_PR/);
});

import {selectAutoPwaCi, buildAutoPwaRelease, validatePwaForward, sealKeypair, sealArtifact, unsealArtifact, PWA_ARTIFACT_PREFIX} from '../scripts/pwa.mjs';

test('pwa auto: selects newest push verificar CI on main and builds valid release', () => {
  const runs = [
    { ...ci(), run_attempt: 2 },
    { ...ci(), head_branch: 'feature' },
    { ...ci(), event: 'pull_request' },
    { ...ci(), id: 555 },
  ];
  const selected = selectAutoPwaCi(runs);
  assert.equal(selected.id, 555);
  const pwaArt = { id: 777, name: PWA_ARTIFACT_PREFIX + S, expired: false, digest: 'sha256:' + D, workflow_run: { id: 555, head_sha: S }, size_in_bytes: 2048 };
  const jobs = REQUIRED_JOBS.map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const pulls = [{ number: 120, merged_at: '2026-11-07T04:00:00Z', merge_commit_sha: S, base: { ref: 'main' } }];
  const rel = buildAutoPwaRelease({ repo: { private: true }, ci: selected, jobs, artifact: pwaArt, pulls });
  assert.equal(rel.application_sha, S);
  assert.equal(rel.artifact_id, 777);
  assert.equal(rel.artifact_digest, D);
  assert.equal(rel.pr, 120);
});

test('pwa auto: rejects tampered or mismatched artifact', () => {
  const pwaArt = { id: 777, name: PWA_ARTIFACT_PREFIX + S, expired: false, digest: 'sha256:' + D, workflow_run: { id: 202, head_sha: S }, size_in_bytes: 2048 };
  const jobs = REQUIRED_JOBS.map(name => ({ name, status: 'completed', conclusion: 'success' }));
  const pulls = [{ number: 120, merged_at: '2026-11-07T04:00:00Z', merge_commit_sha: S, base: { ref: 'main' } }];
  const base = { repo: { private: true }, ci: ci(), jobs, artifact: pwaArt, pulls };
  assert.throws(() => buildAutoPwaRelease({ ...base, repo: { private: false } }), /SOURCE_MUST_REMAIN_PRIVATE/);
  assert.throws(() => buildAutoPwaRelease({ ...base, pulls: [] }), /DIRECT_PUSH_DETECTED_NO_MERGED_PR/);
  assert.throws(() => buildAutoPwaRelease({ ...base, artifact: { ...pwaArt, expired: true } }), /AUTO_PWA_ARTIFACT_MISSING/);
  assert.throws(() => buildAutoPwaRelease({ ...base, artifact: { ...pwaArt, name: 'web-approved-' + S } }), /AUTO_PWA_ARTIFACT_MISSING/);
  assert.throws(() => buildAutoPwaRelease({ ...base, artifact: { ...pwaArt, workflow_run: { id: 999, head_sha: S } } }), /AUTO_PWA_ARTIFACT_MISSING/);
});

test('pwa cryptographic bridge: seals and unseals artifact, rejects wrong token or context', () => {
  const token = 'test-cf-pages-token-secret-1234567890';
  const context = 'run:12345:attempt:1:project:coloxi-app';
  const aad = `${context}:sha:${S}:digest:${D}`;
  const kp = sealKeypair(token, context);
  const payload = Buffer.from('verified-pwa-zip-content');
  const sealed = sealArtifact(payload, kp.publicKey, aad);
  const unsealed = unsealArtifact(sealed, kp.sealedPrivateKey, token, context, aad);
  assert.deepEqual(unsealed, payload);
  assert.throws(() => unsealArtifact(sealed, kp.sealedPrivateKey, 'wrong-token-1234567890', context, aad));
  assert.throws(() => unsealArtifact(sealed, kp.sealedPrivateKey, token, 'wrong-context', aad));
  assert.throws(() => unsealArtifact(sealed, kp.sealedPrivateKey, token, context, 'wrong-aad'));
});



