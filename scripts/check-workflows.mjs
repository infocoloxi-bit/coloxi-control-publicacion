import {readFileSync} from 'node:fs';
import YAML from 'yaml';
import {requireThat} from './policy.mjs';

const workflow = YAML.parse(readFileSync('.github/workflows/publicar-web.yml', 'utf8'));
// Only events that always execute the protected main branch code. Never pull_request*, push, workflow_run.
const triggers = Object.keys(workflow.on).sort().join();
requireThat(triggers === 'schedule,workflow_dispatch' || triggers === 'workflow_dispatch', 'TRUSTED_TRIGGERS_ONLY');
requireThat(workflow.permissions.contents === 'read' && Object.keys(workflow.permissions).length === 1, 'MINIMUM_GITHUB_PERMISSIONS');
requireThat(workflow.jobs.web.environment === 'web-production' && workflow.jobs.web.if.includes("github.ref == 'refs/heads/main'"), 'PROTECTED_ENVIRONMENT');
requireThat(workflow.concurrency['cancel-in-progress'] === false, 'NO_CANCEL_UNCERTAIN');
requireThat(Object.keys(workflow.jobs).length === 1, 'SINGLE_JOB');
let discover = false, forward = false;
for (const step of workflow.jobs.web.steps) {
  if (step.uses) requireThat(/@[a-f0-9]{40}$/.test(step.uses), 'PIN_ACTIONS');
  requireThat(!/upload-artifact|download-artifact/.test(step.uses || ''), 'NO_PUBLIC_ARTIFACT');
  requireThat(!step.with?.['persist-credentials'], 'NO_PERSISTED_CREDENTIAL');
  requireThat(!(step.env?.SOURCE_READER_TOKEN && step.env?.CF_WORKER_PUBLISH_TOKEN), 'SEPARATE_SECRET_STEPS');
  requireThat(!/\$\{\{/.test(step.run || ''), 'NO_EXPRESSIONS_IN_SCRIPTS');
  if (step.run === 'node scripts/source.mjs discover') discover = true;
  if (step.run === 'node scripts/source.mjs forward') {
    forward = true;
    requireThat(step.if?.includes("steps.preflight.outputs.action == 'publish'"), 'FORWARD_BEFORE_WRITE');
  }
}
if (triggers.includes('schedule')) requireThat(discover && forward, 'AUTO_REQUIRES_DISCOVERY_AND_NO_DOWNGRADE');

const pwaWorkflow = YAML.parse(readFileSync('.github/workflows/publicar-pwa.yml', 'utf8'));
const pwaTriggers = Object.keys(pwaWorkflow.on).sort().join();
requireThat(pwaTriggers === 'schedule,workflow_dispatch' || pwaTriggers === 'workflow_dispatch', 'PWA_TRUSTED_TRIGGERS_ONLY');
requireThat(pwaWorkflow.permissions.contents === 'read' && Object.keys(pwaWorkflow.permissions).length === 1, 'PWA_MINIMUM_GITHUB_PERMISSIONS');
requireThat(pwaWorkflow.concurrency['cancel-in-progress'] === false, 'PWA_NO_CANCEL_UNCERTAIN');
requireThat(
  pwaWorkflow.jobs.prepare?.environment === 'pwa-production' &&
    pwaWorkflow.jobs.source?.environment === 'web-production' &&
    pwaWorkflow.jobs.publish?.environment === 'pwa-production',
  'PWA_PROTECTED_ENVIRONMENTS',
);
for (const job of Object.values(pwaWorkflow.jobs)) {
  requireThat(job.if?.includes("github.ref == 'refs/heads/main'"), 'PWA_MAIN_ONLY');
  for (const step of job.steps || []) {
    if (step.uses) requireThat(/@[a-f0-9]{40}$/.test(step.uses), 'PWA_PIN_ACTIONS');
    requireThat(!/upload-artifact|download-artifact/.test(step.uses || ''), 'PWA_NO_PUBLIC_ARTIFACT');
    requireThat(!step.with?.['persist-credentials'], 'PWA_NO_PERSISTED_CREDENTIAL');
    requireThat(!(step.env?.SOURCE_READER_TOKEN && (step.env?.CF_WORKER_PUBLISH_TOKEN || step.env?.CF_PAGES_PUBLISH_TOKEN)), 'PWA_SEPARATE_SECRET_STEPS');
    requireThat(!/\$\{\{/.test(step.run || ''), 'PWA_NO_EXPRESSIONS_IN_SCRIPTS');
  }
}

console.log('Trusted triggers, protected environment, pinned actions, separated credentials and no-downgrade guard verified for Web and PWA.');
