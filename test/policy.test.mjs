import test from 'node:test';
import assert from 'node:assert/strict';
import {loadRelease,validateRelease,validateProvenance,validateDeployment,REQUIRED_JOBS} from '../scripts/policy.mjs';
import {verifyReleasePR} from '../scripts/verify-release-pr.mjs';
const r=loadRelease();
const fixture=()=>({repo:{private:true},main:{object:{sha:r.approved_main_sha}},build:{head_branch:'main',head_sha:r.producer_sha,status:'completed',conclusion:'success',run_attempt:1,event:r.build_event,path:'.github/workflows/preparar-web-aprobada.yml'},ci:{head_sha:r.approved_main_sha,status:'completed',conclusion:'success',name:'verificar'},jobs:REQUIRED_JOBS.map(name=>({name,status:'completed',conclusion:'success'})),artifact:{id:r.artifact_id,name:r.artifact_name,expired:false,workflow_run:{id:r.build_run_id,head_sha:r.producer_sha},digest:'sha256:'+r.artifact_digest,size_in_bytes:30000000}});
test('approved release and provenance pass',()=>assert.equal(validateProvenance(r,fixture()),true));
const descendant=()=>{const f=fixture();f.main.object.sha='a'.repeat(40);f.ancestry={status:'ahead',base_commit:{sha:r.approved_main_sha},merge_base_commit:{sha:r.approved_main_sha},url:'https://api.github.com/repos/example/private/compare/'+r.approved_main_sha+'...'+f.main.object.sha};return f;};
test('later main does not republish unrelated component changes',()=>assert.equal(validateProvenance(r,descendant()),true));
for(const [name,mutate] of [
  ['diverged main',f=>f.ancestry.status='diverged'],
  ['rewritten history',f=>f.ancestry.merge_base_commit.sha='b'.repeat(40)],
  ['wrong comparison head',f=>f.ancestry.url=f.ancestry.url.replace(/a{40}$/,'b'.repeat(40))],
])test('rejects '+name,()=>{const f=descendant();mutate(f);assert.throws(()=>validateProvenance(r,f));});
for(const [name,mutate] of [
  ['changed main',f=>f.main.object.sha='a'.repeat(40)],
  ['public source',f=>f.repo.private=false],
  ['failed CI',f=>f.jobs[0].conclusion='failure'],
  ['missing job',f=>f.jobs.pop()],
  ['substituted job',f=>f.jobs[0].name='unrelated'],
  ['wrong CI SHA',f=>f.ci.head_sha='a'.repeat(40)],
  ['wrong producer',f=>f.build.head_sha='0'.repeat(40)],
  ['wrong build branch',f=>f.build.head_branch='feature'],
  ['rerun build',f=>f.build.run_attempt=2],
  ['expired artifact',f=>f.artifact.expired=true],
  ['wrong artifact ID',f=>f.artifact.id++],
  ['wrong digest',f=>f.artifact.digest='sha256:'+'0'.repeat(64)],
  ['wrong artifact producer',f=>f.artifact.workflow_run.head_sha='0'.repeat(40)],
])test('rejects '+name,()=>{const f=fixture();mutate(f);assert.throws(()=>validateProvenance(r,f));});
test('rejects path traversal release',()=>assert.throws(()=>validateRelease({...r,archive:'../other.tar.gz'})));
test('bootstrap cannot authorize another source',()=>assert.throws(()=>validateRelease({...r,application_sha:'a'.repeat(40)})));
const versionId='5d981330-0822-4fc9-a779-9b71e5e10685';
const deployment={id:r.expected_deployment,versions:[{version_id:versionId,percentage:100}]};
const version={id:versionId,annotations:{'workers/tag':r.application_sha}};
test('already deployed source performs no write',()=>assert.equal(validateDeployment(deployment,version,r,'publish'),'current'));
test('verify requires the current approved version',()=>assert.throws(()=>validateDeployment(deployment,{...version,annotations:{}},r,'verify')));
test('publish rejects concurrent external change',()=>assert.throws(()=>validateDeployment({...deployment,id:r.rollback_version},{...version,annotations:{}},r,'publish')));
test('split traffic is an uncertain state',()=>assert.throws(()=>validateDeployment({...deployment,versions:[{version_id:versionId,percentage:50}]},version,r,'publish')));
test('rollback only from this approved application',()=>assert.equal(validateDeployment(deployment,version,r,'rollback'),'rollback'));
test('rollback from unknown application rejected',()=>assert.throws(()=>validateDeployment(deployment,{...version,annotations:{}},r,'rollback')));

// Tests de protección contra push directo a main sin aprobación de CODEOWNERS
const testCommit = '0bc947d14c1e7a557ae419ce3a1c6683e66ef2ac';
test('verifyReleasePR passes for valid merged PR with codeowner approval', async () => {
  const mockFetch = async (url) => {
    if (url.includes('/pulls?')) {
      return { ok: true, json: async () => [{ number: 99, merged_at: '2026-11-06T00:00:00Z', merge_commit_sha: testCommit }] };
    }
    if (url.includes('/pulls/99/reviews')) {
      return { ok: true, json: async () => [{ state: 'APPROVED', user: { login: 'infocoloxi-bit' } }] };
    }
    throw new Error('Unexpected URL: ' + url);
  };
  const res = await verifyReleasePR({ commitSha: testCommit, fetchFn: mockFetch });
  assert.equal(res.pr, 99);
});

test('verifyReleasePR rejects direct push without merged PR', async () => {
  const mockFetch = async (url) => {
    if (url.includes('/pulls?')) {
      return { ok: true, json: async () => [] };
    }
    throw new Error('Unexpected URL: ' + url);
  };
  await assert.rejects(
    () => verifyReleasePR({ commitSha: testCommit, fetchFn: mockFetch }),
    { message: 'DIRECT_PUSH_DETECTED_NO_MERGED_PR' }
  );
});

test('verifyReleasePR rejects PR missing codeowner approval', async () => {
  const mockFetch = async (url) => {
    if (url.includes('/pulls?')) {
      return { ok: true, json: async () => [{ number: 99, merged_at: '2026-11-06T00:00:00Z', merge_commit_sha: testCommit }] };
    }
    if (url.includes('/pulls/99/reviews')) {
      return { ok: true, json: async () => [{ state: 'COMMENTED', user: { login: 'infocoloxi-bit' } }] };
    }
    throw new Error('Unexpected URL: ' + url);
  };
  await assert.rejects(
    () => verifyReleasePR({ commitSha: testCommit, fetchFn: mockFetch }),
    { message: 'PR_MISSING_CODEOWNER_APPROVAL' }
  );
});

test('verifyReleasePR rejects PR approved by non-codeowner', async () => {
  const mockFetch = async (url) => {
    if (url.includes('/pulls?')) {
      return { ok: true, json: async () => [{ number: 99, merged_at: '2026-11-06T00:00:00Z', merge_commit_sha: testCommit }] };
    }
    if (url.includes('/pulls/99/reviews')) {
      return { ok: true, json: async () => [{ state: 'APPROVED', user: { login: 'unauthorized-user' } }] };
    }
    throw new Error('Unexpected URL: ' + url);
  };
  await assert.rejects(
    () => verifyReleasePR({ commitSha: testCommit, fetchFn: mockFetch }),
    { message: 'PR_MISSING_CODEOWNER_APPROVAL' }
  );
});

test('verifyReleasePR passes bootstrap release with bootstrap evidence', async () => {
  const res = await verifyReleasePR({ release: { bootstrap_evidence: true } });
  assert.equal(res, true);
});
