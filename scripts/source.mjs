import {writeFileSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadRelease, requireThat, validateProvenance} from './policy.mjs';

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
const release=loadRelease();
if(process.argv[2] === 'verify') {
  const [repository,main,build,ci,jobs,artifact]=await Promise.all([
    api(''),api('/git/ref/heads/main'),api('/actions/runs/'+release.build_run_id),
    api('/actions/runs/'+release.ci_run_id),api('/actions/runs/'+release.ci_run_id+'/jobs?per_page=100'),api('/actions/artifacts/'+release.artifact_id),
  ]);
  validateProvenance(release,{repo:repository,main,build,ci,jobs:jobs.jobs,artifact});
  console.log('Approved source, four CI jobs and private artifact provenance verified.');
} else if(process.argv[2] === 'download') {
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
