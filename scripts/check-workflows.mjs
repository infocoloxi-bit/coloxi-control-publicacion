import {readFileSync} from 'node:fs';
import YAML from 'yaml';
import {requireThat} from './policy.mjs';
const workflow=YAML.parse(readFileSync('.github/workflows/publicar-web.yml','utf8'));
requireThat(Object.keys(workflow.on).join() === 'workflow_dispatch','MANUAL_ONLY');
requireThat(workflow.permissions.contents === 'read' && Object.keys(workflow.permissions).length === 1,'MINIMUM_GITHUB_PERMISSIONS');
requireThat(workflow.jobs.web.environment === 'web-production' && workflow.jobs.web.if.includes("github.ref == 'refs/heads/main'"),'PROTECTED_ENVIRONMENT');
requireThat(workflow.concurrency['cancel-in-progress'] === false,'NO_CANCEL_UNCERTAIN');
for(const step of workflow.jobs.web.steps){
  if(step.uses)requireThat(/@[a-f0-9]{40}$/.test(step.uses),'PIN_ACTIONS');
  requireThat(!/upload-artifact|download-artifact/.test(step.uses||''),'NO_PUBLIC_ARTIFACT');
  requireThat(!step.with?.['persist-credentials'],'NO_PERSISTED_CREDENTIAL');
  requireThat(!(step.env?.SOURCE_READER_TOKEN && step.env?.CF_WORKER_PUBLISH_TOKEN),'SEPARATE_SECRET_STEPS');
}
console.log('Manual-only workflow, protected environment, pinned actions and separated credentials verified.');
