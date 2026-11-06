import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {loadRelease,requireThat,validateDeployment} from './policy.mjs';

const account=process.env.CF_ACCOUNT_ID, worker=process.env.CF_WORKER_NAME, token=process.env.CF_WORKER_PUBLISH_TOKEN;
requireThat(/^[a-f0-9]{32}$/.test(account||'') && /^[a-z0-9-]{1,63}$/.test(worker||'') && token,'CF_CONFIGURATION');
const operation=process.env.OPERATION || 'verify', release=loadRelease();
const originList=JSON.parse(process.env.PUBLIC_ORIGINS || '[]');
requireThat(originList.length>0 && originList.every(s=>{try{const u=new URL(s);return u.protocol==='https:' && u.origin===s && !u.username && !u.password;}catch{return false;}}),'PUBLIC_ORIGINS');
async function api(path,method='GET',body) {
  const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/scripts/'+worker+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});
  requireThat(r.ok,'CLOUDFLARE_HTTP_'+r.status);const j=await r.json();requireThat(j.success,'CLOUDFLARE_UNCERTAIN');return j.result;
}
async function current(){const d=(await api('/deployments')).deployments[0];return {deployment:d,version:await api('/versions/'+d.versions[0].version_id)};}
function report(result,d){const text=`${result}; application ${release.application_sha}; deployment ${d.id}`;console.log(text);if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,text+'\n');}
const before=await current();
const action=validateDeployment(before.deployment,before.version,release,operation);
if(process.argv[2]==='preflight') {
  if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,'action='+action+'\n');
  report(action==='current'?'ALREADY_CURRENT_NO_WRITE':'PREFLIGHT_'+action.toUpperCase(),before.deployment);
} else if(process.argv[2]==='execute') {
  if(action==='current') {report('ALREADY_CURRENT_NO_WRITE',before.deployment);}
  else if(action==='rollback') {
    const target=await api('/versions/'+release.rollback_version);requireThat(target.id===release.rollback_version,'ROLLBACK_VERSION_MISSING');
    const after=await api('/deployments','POST',{strategy:'percentage',versions:[{version_id:release.rollback_version,percentage:100}],annotations:{'workers/message':'Approved supervised rollback'}});
    requireThat(after.versions?.[0]?.version_id===release.rollback_version,'ROLLBACK_UNCERTAIN_DO_NOT_REPEAT');report('ROLLED_BACK',after);
  } else {
    const dir=resolve('.private/delivery');const manifest=JSON.parse(readFileSync(dir+'/manifest.json','utf8'));
    requireThat(manifest.source_sha===release.application_sha && manifest.cuenta===account && manifest.worker===worker && manifest.sin_secretos===true,'BUNDLE_MANIFEST');
    requireThat(/^[\w.-]+\.(m?js)$/.test(manifest.entrypoint) && !manifest.entrypoint.includes('..'),'BUNDLE_ENTRY');
    requireThat(createHash('sha256').update(readFileSync(dir+'/bundle/'+manifest.entrypoint)).digest('hex')===manifest.entry_sha256,'BUNDLE_HASH');
    const settings=await api('/settings');const bindings=settings.bindings.map(x=>({name:x.name,type:x.type}));
    requireThat(bindings.some(x=>x.name==='ASSETS'&&x.type==='assets'),'ASSET_BINDING');
    // Ignore the downloaded Wrangler configuration. No arbitrary routes/bindings/build commands are accepted.
    const config={name:worker,account_id:account,main:'bundle/'+manifest.entrypoint,no_bundle:true,find_additional_modules:true,compatibility_date:'2026-09-01',compatibility_flags:['nodejs_compat'],keep_vars:true,assets:{binding:'ASSETS',directory:'assets'},rules:[{type:'CompiledWasm',globs:['**/*.wasm'],fallthrough:true},{type:'Data',globs:['**/*.bin'],fallthrough:true}],observability:settings.observability||{enabled:true}};
    writeFileSync(dir+'/trusted-wrangler.json',JSON.stringify(config));
    const cli=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--config',dir+'/trusted-wrangler.json','--keep-vars','--tag',release.application_sha,'--message','Approved controlled publication '+release.application_sha],{encoding:'utf8',timeout:600000,maxBuffer:8*1024*1024,env:{...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:account,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_SANITIZE:'true'}});
    // Never print the CLI output: source names, maps, settings and errors may contain private information.
    const after=await current();requireThat(after.deployment.id!==before.deployment.id,'NO_NEW_DEPLOYMENT_DO_NOT_REPEAT');
    requireThat(after.version.annotations?.['workers/tag']===release.application_sha,'DEPLOYMENT_UNCERTAIN_DO_NOT_REPEAT');
    const bindingsAfter=(await api('/settings')).bindings.map(x=>({name:x.name,type:x.type}));
    requireThat(bindings.every(b=>bindingsAfter.some(a=>a.name===b.name&&a.type===b.type)),'BINDING_CHANGED_STOP');
    let regression=false;
    for(const origin of originList){const response=await fetch(origin+'/',{redirect:'follow',signal:AbortSignal.timeout(20000)});if(!response.ok)regression=true;}
    if(regression){const reverted=await api('/deployments','POST',{strategy:'percentage',versions:before.deployment.versions,annotations:{'workers/message':'Rollback after confirmed HTTP regression'}});report('HTTP_REGRESSION_ROLLED_BACK',reverted);throw Error('HTTP_REGRESSION');}
    report(cli.status===0?'PUBLISHED':'PUBLISHED_RECONCILED_CLI_ERROR',after.deployment);
  }
} else throw Error('CF_OPERATION');
