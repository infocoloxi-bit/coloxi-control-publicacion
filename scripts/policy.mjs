import {readFileSync} from 'node:fs';

export function requireThat(value, code) { if (!value) throw new Error(code); }
export const SHA = /^[a-f0-9]{40}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const REQUIRED_JOBS = [
  'Build, tests y reglas', 'Sintaxis de los plugins y del tema',
  'Estructura y accesibilidad en navegador real', 'Integridad de la fuente',
];
export function validateRelease(r) {
  requireThat(r?.schema === 1, 'RELEASE_SCHEMA');
  for (const key of ['application_sha','approved_main_sha','producer_sha']) requireThat(SHA.test(r[key]), 'RELEASE_SHA');
  for (const key of ['build_run_id','ci_run_id','artifact_id']) requireThat(Number.isSafeInteger(r[key]) && r[key] > 0, 'RELEASE_ID');
  for (const key of ['artifact_digest','archive_sha256']) requireThat(HASH.test(r[key]), 'RELEASE_HASH');
  for (const key of ['expected_deployment','rollback_version']) requireThat(UUID.test(r[key]), 'RELEASE_VERSION');
  requireThat(/^[a-zA-Z0-9_-]{1,100}$/.test(r.artifact_name), 'RELEASE_ARTIFACT');
  requireThat(/^[a-zA-Z0-9_-]{1,100}\.tar\.gz$/.test(r.archive), 'RELEASE_ARCHIVE');
  requireThat(['workflow_dispatch','push'].includes(r.build_event), 'RELEASE_EVENT');
  // Only the already deployed, explicitly approved bootstrap can separate build/workflow/application SHAs.
  if (r.bootstrap_evidence) {
    requireThat(r.application_sha === '0d2433ac749f48fd1f7f0041038f159241e3baaa' &&
      r.approved_main_sha === '31b0088d3ad9017c743ee05029202d02a175c442' &&
      r.producer_sha === '90b78c9d65d46e2939830009bd7cea3aa2ce587e' &&
      r.build_run_id === 42284676332 && r.artifact_id === 13536413222 &&
      r.artifact_digest === '30428e3330db94f022cdd9ae83756436564c2838cd81dc73b2a369da6f1e697d' &&
      r.archive_sha256 === '30375172ad9bd9db7376925b5592e9412760fcc3001bf68aed11fbea002ca46a', 'BOOTSTRAP_CHANGED');
  } else requireThat(r.application_sha === r.approved_main_sha && r.producer_sha === r.application_sha && r.build_event === 'workflow_dispatch', 'BUILD_SOURCE_MISMATCH');
  return r;
}
export function loadRelease() {return validateRelease(JSON.parse(readFileSync('releases/web.json','utf8')));}
export function validateProvenance(r, {repo, main, ancestry, build, ci, jobs, artifact}) {
  requireThat(repo.private === true, 'SOURCE_MUST_REMAIN_PRIVATE');
  requireThat(main.object?.sha === r.approved_main_sha ||
    (SHA.test(main.object?.sha || '') && ancestry?.status === 'ahead' &&
     ancestry.base_commit?.sha === r.approved_main_sha && ancestry.merge_base_commit?.sha === r.approved_main_sha &&
     ancestry.url?.endsWith('/compare/'+r.approved_main_sha+'...'+main.object.sha)), 'APPROVED_SOURCE_NOT_IN_MAIN');
  requireThat(build.head_sha === r.producer_sha && build.status === 'completed' && build.conclusion === 'success' && build.run_attempt === 1 && build.event === r.build_event && build.path === '.github/workflows/preparar-web-aprobada.yml', 'BUILD_NOT_APPROVED');
  if (!r.bootstrap_evidence) requireThat(build.head_branch === 'main', 'BUILD_NOT_FROM_MAIN');
  requireThat(ci.head_sha === r.approved_main_sha && ci.status === 'completed' && ci.conclusion === 'success' && ci.name === 'verificar', 'CI_NOT_APPROVED');
  requireThat(jobs.length === 4 && REQUIRED_JOBS.every(name => jobs.some(j => j.name === name && j.status === 'completed' && j.conclusion === 'success')), 'CI_REQUIRED_JOBS');
  requireThat(artifact.id === r.artifact_id && artifact.name === r.artifact_name && artifact.expired === false && artifact.workflow_run?.id === r.build_run_id && artifact.workflow_run?.head_sha === r.producer_sha && artifact.digest === 'sha256:'+r.artifact_digest && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 128*1024*1024, 'ARTIFACT_NOT_APPROVED');
  return true;
}
export function validateDeployment(deployment, version, r, operation) {
  requireThat(['verify','publish','rollback'].includes(operation), 'OPERATION');
  requireThat(UUID.test(deployment?.id) && deployment.versions?.length === 1 && deployment.versions[0].percentage === 100 && UUID.test(deployment.versions[0].version_id), 'UNCERTAIN_DEPLOYMENT');
  const tag = version?.annotations?.['workers/tag'];
  requireThat(version?.id === deployment.versions[0].version_id, 'VERSION_CHANGED');
  if (operation === 'rollback') {
    requireThat(tag === r.application_sha && deployment.versions[0].version_id !== r.rollback_version, 'ROLLBACK_NOT_APPROVED');
    return 'rollback';
  }
  if (tag === r.application_sha) return 'current';
  requireThat(deployment.id === r.expected_deployment, 'DEPLOYMENT_CHANGED');
  requireThat(operation === 'publish', 'VERSION_NOT_CURRENT');
  return 'publish';
}
