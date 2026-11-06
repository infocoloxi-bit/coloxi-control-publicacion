import {readdirSync,readFileSync} from 'node:fs';
import {requireThat} from './policy.mjs';
const allow=['.github/','.gitignore','README.md','package.json','package-lock.json','releases/','scripts/','test/'];
function walk(dir='.') {for(const entry of readdirSync(dir,{withFileTypes:true})){
  if(['.git','node_modules','.private'].includes(entry.name))continue;
  const path=dir==='.'?entry.name:dir+'/'+entry.name;
  requireThat(allow.some(p=>path===p||path===p.replace(/\/$/,'')||path.startsWith(p)),'PUBLIC_FILE_NOT_ALLOWED');
  requireThat(!entry.isSymbolicLink(),'NO_SYMLINK');
  if(entry.isDirectory())walk(path);else {
    requireThat(!/\.(php|tsx|avif|webp|sql|zip|gz|pem|key|dpapi)$/.test(path),'NO_APPLICATION_OR_SECRET');
    const s=readFileSync(path,'utf8');
    requireThat(!/github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(s),'SECRET_PATTERN');
    requireThat(!/['"][a-f0-9]{32}['"]/.test(s),'NO_ACCOUNT_DETAILS');
  }
}}
walk();console.log('Only generic controller code and approved release identifiers; no application files or credentials.');
