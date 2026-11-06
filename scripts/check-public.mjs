import {lstatSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {requireThat} from './policy.mjs';
const allow=['.github/','.gitignore','README.md','package.json','package-lock.json','releases/','scripts/','test/'];
// Include force-added ignored files. Gitignore is not a confidentiality boundary.
const files=new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean));
for(const path of files){
    requireThat(allow.some(p=>path===p||path.startsWith(p)),'PUBLIC_FILE_NOT_ALLOWED');
    requireThat(!lstatSync(path).isSymbolicLink(),'NO_SYMLINK');
    requireThat(!/\.(php|tsx|avif|webp|sql|zip|gz|pem|key|dpapi)$/.test(path),'NO_APPLICATION_OR_SECRET');
    const s=readFileSync(path,'utf8');
    requireThat(!/github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(s),'SECRET_PATTERN');
    requireThat(!/['"][a-f0-9]{32}['"]/.test(s),'NO_ACCOUNT_DETAILS');
}
console.log('Only generic controller code and approved release identifiers; no application files or credentials.');
