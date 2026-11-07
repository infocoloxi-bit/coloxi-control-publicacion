import {writeFileSync, mkdirSync, appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadRelease, requireThat, validateProvenance, selectAutoBuild, buildAutoRelease, validateForward, SHA} from './policy.mjs';

const repo=process.env.SOURCE_REPOSITORY;
requireThat(/^[\w.-]+\/[\w.-]+$/.test(repo||''), 'SOURCE_REPOSITORY');
const token=process.env.SOURCE_READER_TOKEN;
requireThat(token, 'SOURCE_READER_MISSING');
const root='https://api.github.com/repos/'+repo;
async function api(path, raw=false) {
  const r=await fetch(root+path,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'manual',signal:AbortSignal.timeout(30000)});
  if(raw)return r;
  requireThat(r.ok, 'GITHUB_HTTP_'+r.status);
  return r.json();
}
function output(line){if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,line+'\n');}
const op=process.argv[2];
if(op === 'discover') {
  // Derive the release from evidence only: no human-edited manifest, no workflow input is trusted.
  const runs=await api('/actions/workflows/preparar-web-aprobada.yml/runs?branch=main&event=workflow_dispatch&status=success&per_page=20');
  const build=selectAutoBuild(runs.workflow_runs);
  requireThat(build, 'NO_APPROVED_BUILD');
  const cis=await api('/actions/workflows/verificar.yml/runs?branch=main&event=push&status=success&per_page=10&head_sha='+build.head_sha);
  const ci=(cis.workflow_runs||[]).find(c=>c.head_sha===build.head_sha && c.run_attempt>=1);
  const arts=await api('/actions/runs/'+build.id+'/artifacts?per_page=10');
  const artifact=(arts.artifacts||[]).find(a=>a.name==='web-approved-'+build.head_sha);
  const release=buildAutoRelease({build,ci,artifact});
  writeFileSync('releases/web.json',JSON.stringify(release,null,2)+'\n');
  output('candidate='+release.application_sha);
  console.log('Automatic candidate '+release.application_sha+' derived from private main evidence.');
} else if(op === 'verify') {
  const release=loadRelease();
  const [repository,main,build,ci,jobs,artifact]=await Promise.all([
    api(''),api('/git/ref/heads/main'),api('/actions/runs/'+release.build_run_id),
    api('/actions/runs/'+release.ci_run_id),api('/actions/runs/'+release.ci_run_id+'/jobs?per_page=100'),api('/actions/artifacts/'+release.artifact_id),
  ]);
  const ancestry=main.object?.sha === release.approved_main_sha ? undefined :
    await api('/compare/'+release.approved_main_sha+'...'+main.object.sha+'?per_page=1');
  validateProvenance(release,{repo:repository,main,ancestry,build,ci,jobs:jobs.jobs,artifact});
  console.log('Approved source, four CI jobs and private artifact provenance verified.');
} else if(op === 'forward') {
  const release=loadRelease();
  const production=process.env.PRODUCTION_SHA;
  requireThat(release.mode === 'auto' && SHA.test(production||''), 'FORWARD_INPUT');
  const comparison=await api('/compare/'+production+'...'+release.application_sha+'?per_page=1');
  validateForward(release,production,comparison);
  console.log('Candidate is strictly ahead of the version in production; no downgrade.');
} else if(op === 'download') {
  const release=loadRelease();
  const r=await api('/actions/artifacts/'+release.artifact_id+'/zip',true);
  requireThat(r.status === 302, 'ARTIFACT_REDIRECT');
  const url=new URL(r.headers.get('location'));
  requireThat(url.protocol === 'https:' && !url.username && !url.password && (url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.actions.githubusercontent.com')), 'ARTIFACT_HOST');
  const zip=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(120000)});
  requireThat(zip.ok, 'DOWNLOAD_HTTP_'+zip.status);
  const size=Number(zip.headers.get('content-length'));
  requireThat(size>0 && size<=128*1024*1024, 'DOWNLOAD_SIZE');
  const data=Buffer.from(await zip.arrayBuffer());
  requireThat(data.length===size && createHash('sha256').update(data).digest('hex')===release.artifact_digest, 'DOWNLOAD_HASH');
  mkdirSync('.private',{recursive:true});writeFileSync('.private/source.zip',data,{mode:0o600});
  console.log('Private artifact downloaded and digest verified; no public artifact will be uploaded.');
} else throw Error('SOURCE_OPERATION');
