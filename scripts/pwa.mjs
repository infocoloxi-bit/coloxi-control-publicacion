import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  generateKeyPairSync,
  hkdfSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {HASH, REQUIRED_JOBS, SHA, UUID, requireThat, validateSourcePR} from './policy.mjs';

const SHORT_OR_FULL_SHA = /^[a-f0-9]{7,40}$/;
export const PWA_ARTIFACT_PREFIX = 'pwa-comercial-';
const ENTRADA_BFF = '_worker.js/index.js';
const MANIFIESTO_ARTEFACTO = 'coloxi-artefacto.json';

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function selectAutoPwaCi(runs) {
  return (runs || []).find(
    r =>
      r.status === 'completed' &&
      r.conclusion === 'success' &&
      (r.run_attempt || 1) === 1 &&
      r.event === 'push' &&
      r.head_branch === 'main' &&
      r.name === 'verificar' &&
      SHA.test(r.head_sha || ''),
  ) || null;
}

export function buildAutoPwaRelease({repo, ci, jobs, artifact, pulls}) {
  requireThat(repo?.private === true, 'SOURCE_MUST_REMAIN_PRIVATE');
  requireThat(ci && SHA.test(ci.head_sha || '') && ci.status === 'completed' && ci.conclusion === 'success' && ci.event === 'push' && ci.head_branch === 'main' && ci.name === 'verificar', 'AUTO_PWA_CI_MISSING');
  const sourcePR = validateSourcePR(ci.head_sha, pulls);
  requireThat(
    Array.isArray(jobs) &&
      jobs.length === 4 &&
      REQUIRED_JOBS.every(name => jobs.some(j => j.name === name && j.status === 'completed' && j.conclusion === 'success')),
    'CI_REQUIRED_JOBS',
  );
  requireThat(
    artifact &&
      artifact.name === 'pwa-comercial-' + ci.head_sha &&
      artifact.expired === false &&
      artifact.workflow_run?.id === ci.id &&
      /^sha256:[a-f0-9]{64}$/.test(artifact.digest || '') &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= 100 * 1024 * 1024,
    'AUTO_PWA_ARTIFACT_MISSING',
  );
  return {
    schema: 1,
    mode: 'auto',
    target: 'pwa',
    application_sha: ci.head_sha,
    approved_main_sha: ci.head_sha,
    ci_run_id: ci.id,
    ci_attempt: ci.run_attempt || 1,
    artifact_id: artifact.id,
    artifact_name: artifact.name,
    artifact_digest: artifact.digest.slice(7),
    pr: sourcePR.pr,
  };
}

export function validatePwaForward(candidateSha, productionSha, comparison) {
  requireThat(SHA.test(candidateSha || '') && SHORT_OR_FULL_SHA.test(productionSha || ''), 'PWA_FORWARD_INPUT');
  requireThat(
    comparison?.status === 'ahead' &&
      comparison.ahead_by > 0 &&
      comparison.behind_by === 0 &&
      comparison.base_commit?.sha?.startsWith(productionSha) &&
      comparison.merge_base_commit?.sha?.startsWith(productionSha),
    'CANDIDATE_NOT_AHEAD_OF_PRODUCTION',
  );
  return true;
}

export function sealKeypair(secret, context) {
  requireThat(typeof secret === 'string' && secret.trim().length >= 16 && typeof context === 'string' && context.length > 0, 'SEAL_KEY_INPUT');
  const {publicKey, privateKey} = generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: {type: 'spki', format: 'der'},
    privateKeyEncoding: {type: 'pkcs8', format: 'der'},
  });
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret.trim(), 'utf8'), Buffer.from(context, 'utf8'), Buffer.from('coloxi-pwa-key-seal-v1', 'utf8'), 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const enc = Buffer.concat([cipher.update(privateKey), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    publicKey: publicKey.toString('base64'),
    sealedPrivateKey: Buffer.concat([iv, tag, enc]).toString('base64'),
  };
}

export function sealArtifact(zipBuffer, publicKeyBase64, aadString) {
  requireThat(Buffer.isBuffer(zipBuffer) && zipBuffer.length > 0 && typeof publicKeyBase64 === 'string' && typeof aadString === 'string', 'SEAL_ARTIFACT_INPUT');
  const publicKeyDer = Buffer.from(publicKeyBase64, 'base64');
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  cipher.setAAD(Buffer.from(aadString, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(zipBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrappedKey = publicEncrypt(
    {
      key: publicKeyDer,
      format: 'der',
      type: 'spki',
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey,
  );
  const header = Buffer.alloc(4);
  header.writeUInt32BE(wrappedKey.length, 0);
  return Buffer.concat([header, wrappedKey, iv, tag, ciphertext]);
}

export function unsealArtifact(sealedBuffer, sealedPrivateKeyBase64, secret, context, aadString) {
  requireThat(
    Buffer.isBuffer(sealedBuffer) &&
      sealedBuffer.length > 36 &&
      typeof sealedPrivateKeyBase64 === 'string' &&
      typeof secret === 'string' &&
      secret.trim().length >= 16 &&
      typeof context === 'string' &&
      typeof aadString === 'string',
    'UNSEAL_ARTIFACT_INPUT',
  );
  const rawKeyBlob = Buffer.from(sealedPrivateKeyBase64, 'base64');
  requireThat(rawKeyBlob.length > 28, 'SEALED_KEY_INVALID');
  const keyIv = rawKeyBlob.subarray(0, 12);
  const keyTag = rawKeyBlob.subarray(12, 28);
  const keyEnc = rawKeyBlob.subarray(28);
  const hkdfKey = Buffer.from(hkdfSync('sha256', Buffer.from(secret.trim(), 'utf8'), Buffer.from(context, 'utf8'), Buffer.from('coloxi-pwa-key-seal-v1', 'utf8'), 32));
  const keyDecipher = createDecipheriv('aes-256-gcm', hkdfKey, keyIv);
  keyDecipher.setAAD(Buffer.from(context, 'utf8'));
  keyDecipher.setAuthTag(keyTag);
  const privateKeyDer = Buffer.concat([keyDecipher.update(keyEnc), keyDecipher.final()]);

  const wrappedLen = sealedBuffer.readUInt32BE(0);
  requireThat(wrappedLen >= 256 && wrappedLen <= 1024 && 4 + wrappedLen + 28 <= sealedBuffer.length, 'SEALED_HEADER_INVALID');
  const wrappedKey = sealedBuffer.subarray(4, 4 + wrappedLen);
  const iv = sealedBuffer.subarray(4 + wrappedLen, 4 + wrappedLen + 12);
  const tag = sealedBuffer.subarray(4 + wrappedLen + 12, 4 + wrappedLen + 28);
  const ciphertext = sealedBuffer.subarray(4 + wrappedLen + 28);

  const aesKey = privateDecrypt(
    {
      key: privateKeyDer,
      format: 'der',
      type: 'pkcs8',
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    wrappedKey,
  );
  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAAD(Buffer.from(aadString, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function extractAndVerifyPwaZip(zip, release, destino = null) {
  requireThat(Buffer.isBuffer(zip) && zip.length >= 22 && zip.length <= 100 * 1024 * 1024, 'PWA_ZIP_INVALID');
  requireThat(release && SHA.test(release.application_sha || ''), 'PWA_RELEASE_SHA');
  let fin = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) {
      fin = i;
      break;
    }
  }
  requireThat(fin >= 0 && zip.readUInt16LE(fin + 4) === 0 && zip.readUInt16LE(fin + 6) === 0, 'PWA_ZIP_MULTIDISK');
  const cantidad = zip.readUInt16LE(fin + 10);
  const tamano = zip.readUInt32LE(fin + 12);
  const inicio = zip.readUInt32LE(fin + 16);
  requireThat(cantidad > 0 && cantidad <= 5000 && inicio + tamano === fin, 'PWA_ZIP_DIRECTORY');

  const archivos = new Map();
  let pos = inicio;
  let total = 0;
  for (let n = 0; n < cantidad; n++) {
    requireThat(pos + 46 <= fin && zip.readUInt32LE(pos) === 0x02014b50, 'PWA_ZIP_ENTRY');
    const flags = zip.readUInt16LE(pos + 8);
    const metodo = zip.readUInt16LE(pos + 10);
    const comprimido = zip.readUInt32LE(pos + 20);
    const bytes = zip.readUInt32LE(pos + 24);
    const largo = zip.readUInt16LE(pos + 28);
    const extra = zip.readUInt16LE(pos + 30);
    const comentario = zip.readUInt16LE(pos + 32);
    const modo = zip.readUInt32LE(pos + 38) >>> 16;
    const offset = zip.readUInt32LE(pos + 42);
    requireThat(pos + 46 + largo + extra + comentario <= fin && !(flags & 1) && [0, 8].includes(metodo), 'PWA_ZIP_METHOD');
    const nombre = zip.subarray(pos + 46, pos + 46 + largo).toString('utf8');
    pos += 46 + largo + extra + comentario;
    requireThat(
      /^[A-Za-z0-9_./@+-]+$/.test(nombre) &&
        !nombre.startsWith('/') &&
        !nombre.includes('\\') &&
        !nombre.split('/').some(p => p === '..' || p === '.' || p.startsWith('.') || /^(?:node_modules|functions|package\.json|wrangler.*|.*\.(?:pem|key|pfx|env))$/i.test(p)),
      'PWA_ZIP_PATH_FORBIDDEN',
    );
    if (nombre.endsWith('/')) {
      requireThat((modo & 0o170000) !== 0o120000, 'PWA_ZIP_SYMLINK');
      continue;
    }
    requireThat(
      !archivos.has(nombre) &&
        [0, 0o100000].includes(modo & 0o170000) &&
        bytes <= 25 * 1024 * 1024 &&
        offset + 30 <= inicio &&
        zip.readUInt32LE(offset) === 0x04034b50,
      'PWA_ZIP_FILE_HEADER',
    );
    const l = zip.readUInt16LE(offset + 26);
    const e = zip.readUInt16LE(offset + 28);
    const principio = offset + 30 + l + e;
    requireThat(zip.subarray(offset + 30, offset + 30 + l).toString('utf8') === nombre && principio + comprimido <= inicio, 'PWA_ZIP_LOCAL_MISMATCH');
    const datos = zip.subarray(principio, principio + comprimido);
    const contenido = metodo === 0 ? datos : inflateRawSync(datos, {maxOutputLength: 25 * 1024 * 1024});
    total += contenido.length;
    requireThat(contenido.length === bytes && total <= 100 * 1024 * 1024, 'PWA_ZIP_SIZE_MISMATCH');
    archivos.set(nombre, contenido);
  }

  requireThat(
    pos === fin &&
      archivos.has('index.html') &&
      archivos.has('sw.js') &&
      archivos.has(ENTRADA_BFF) &&
      !archivos.has('_worker.js') &&
      archivos.has('coloxi-release.json') &&
      archivos.has(MANIFIESTO_ARTEFACTO),
    'PWA_ARTIFACT_INCOMPLETE',
  );

  const procedencia = JSON.parse(archivos.get('coloxi-release.json').toString('utf8'));
  requireThat(procedencia?.formato === 1 && procedencia.sha === release.application_sha, 'PWA_RELEASE_SHA_MISMATCH');
  if (release.ci_run_id) {
    requireThat(procedencia.ciRunId === Number(release.ci_run_id) && procedencia.ciAttempt === Number(release.ci_attempt || 1), 'PWA_RELEASE_CI_MISMATCH');
  }

  const manifiesto = JSON.parse(archivos.get(MANIFIESTO_ARTEFACTO).toString('utf8'));
  requireThat(
    manifiesto?.formato === 1 &&
      manifiesto.bff?.formato === 'pages-worker-directory' &&
      manifiesto.bff?.entrada === ENTRADA_BFF,
    'PWA_BFF_CONTRACT',
  );
  const inventario = [...archivos]
    .filter(([ruta]) => ruta !== MANIFIESTO_ARTEFACTO)
    .map(([ruta, b]) => ({ruta, bytes: b.length, sha256: sha256Hex(b)}))
    .sort((a, b) => (a.ruta < b.ruta ? -1 : a.ruta > b.ruta ? 1 : 0));
  requireThat(JSON.stringify(manifiesto.archivos) === JSON.stringify(inventario), 'PWA_MANIFEST_HASH_MISMATCH');

  for (const [ruta, b] of archivos) {
    if (ruta.startsWith('_worker.js/') && /\.(?:m?js)$/.test(ruta)) {
      requireThat(
        !/^\s*-{2,}formdata-/i.test(b.toString('utf8')) && !b.subarray(0, 1000).includes(Buffer.from('Content-Disposition: form-data;')),
        'PWA_BFF_MULTIPART_FORBIDDEN',
      );
    }
  }

  if (destino) {
    const rootDir = resolve(destino);
    mkdirSync(rootDir, {recursive: true, mode: 0o700});
    for (const [nombre, contenido] of archivos) {
      const ruta = join(rootDir, nombre);
      mkdirSync(dirname(ruta), {recursive: true, mode: 0o700});
      writeFileSync(ruta, contenido, {flag: 'wx', mode: 0o600});
    }
  }
  return {files: archivos.size, sha: procedencia.sha, bffRoutes: procedencia.rutasBff || []};
}

function output(line) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line + '\n');
}

function report(result, sha, deploymentId) {
  const text = `${result}; application ${sha}; deployment ${deploymentId}`;
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
}

async function cfApi(token, path, method = 'GET', body) {
  const r = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    ...(body ? {body: JSON.stringify(body)} : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  requireThat(r.ok, 'CLOUDFLARE_HTTP_' + r.status);
  const j = await r.json();
  requireThat(j.success === true, 'CLOUDFLARE_UNCERTAIN');
  return j.result;
}

async function resolveCfAccount(token, explicitAccount, project) {
  if (explicitAccount && /^[a-f0-9]{32}$/.test(explicitAccount)) return explicitAccount;
  const accounts = await cfApi(token, '/accounts');
  requireThat(Array.isArray(accounts) && accounts.length > 0, 'CF_NO_ACCOUNTS');
  for (const acc of accounts) {
    if (!/^[a-f0-9]{32}$/.test(acc?.id || '')) continue;
    try {
      const p = await cfApi(token, `/accounts/${acc.id}/pages/projects/${project}`);
      if (p?.name === project) return acc.id;
    } catch {
      // Continue searching accounts visible to token
    }
  }
  requireThat(accounts.length === 1 && /^[a-f0-9]{32}$/.test(accounts[0].id), 'CF_ACCOUNT_AMBIGUOUS');
  return accounts[0].id;
}

async function getVerifiedPagesProject(token, account, project) {
  const p = await cfApi(token, `/accounts/${account}/pages/projects/${project}`);
  requireThat(
    p?.name === project &&
      p.production_branch === 'main' &&
      Array.isArray(p.domains) &&
      p.domains.includes('app.coloxi.net') &&
      !p.source,
    'CF_PAGES_PROJECT_INVALID',
  );
  const d = p.canonical_deployment;
  requireThat(UUID.test(d?.id || '') && d.latest_stage?.status === 'success', 'CF_PAGES_NO_CANONICAL_DEPLOYMENT');
  const sha = d.deployment_trigger?.metadata?.commit_hash || '';
  requireThat(SHORT_OR_FULL_SHA.test(sha), 'CF_PAGES_COMMIT_HASH_MISSING');
  return {project: p, deployment: d, sha};
}

async function ghApi(repo, token, path, raw = false) {
  const r = await fetch('https://api.github.com/repos/' + repo + path, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  });
  if (raw) return r;
  requireThat(r.ok, 'GITHUB_HTTP_' + r.status);
  return r.json();
}

async function main() {
  const op = process.argv[2];
  const project = process.env.CF_PAGES_PROJECT || 'coloxi-app';
  requireThat(/^[a-z0-9-]{1,63}$/.test(project), 'CF_PAGES_PROJECT_NAME');
  const runId = process.env.GITHUB_RUN_ID || 'local';
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';

  if (op === 'prepare') {
    const token = process.env.CF_PAGES_PUBLISH_TOKEN;
    requireThat(token, 'CF_PAGES_TOKEN_MISSING');
    const context = `${runId}:${runAttempt}:${project}`;
    const {publicKey, sealedPrivateKey} = sealKeypair(token, context);
    output('public_key=' + publicKey);
    output('sealed_key=' + sealedPrivateKey);
    try {
      const account = await resolveCfAccount(token, process.env.CF_ACCOUNT_ID, project);
      const current = await getVerifiedPagesProject(token, account, project);
      output('account_id=' + account);
      output('deployment_id=' + current.deployment.id);
      output('production_sha=' + current.sha);
      console.log(`PREFLIGHT_PWA; current_application ${current.sha}; deployment ${current.deployment.id}`);
    } catch {
      console.log('PREFLIGHT_PWA; keypair sealed; Cloudflare project check deferred to publish with CF_ACCOUNT_ID from web-production.');
    }
  } else if (op === 'source') {
    const repoName = process.env.SOURCE_REPOSITORY;
    requireThat(/^[\w.-]+\/[\w.-]+$/.test(repoName || ''), 'SOURCE_REPOSITORY');
    const token = process.env.SOURCE_READER_TOKEN;
    requireThat(token, 'SOURCE_READER_MISSING');
    const publicKey = process.env.PUBLIC_KEY;
    const productionSha = process.env.PRODUCTION_SHA || '';
    const deploymentId = process.env.DEPLOYMENT_ID || '';
    const accountId = process.env.CF_ACCOUNT_ID || process.env.ACCOUNT_ID || '';
    requireThat(publicKey && /^[a-f0-9]{32}$/.test(accountId), 'SOURCE_INPUT_INVALID');
    if (process.env.CF_ACCOUNT_ID && process.env.ACCOUNT_ID) {
      requireThat(process.env.CF_ACCOUNT_ID === process.env.ACCOUNT_ID, 'CF_ACCOUNT_MISMATCH');
    }
    output('account_id=' + accountId);

    const [repoInfo, runs] = await Promise.all([
      ghApi(repoName, token, ''),
      ghApi(repoName, token, '/actions/workflows/verificar.yml/runs?branch=main&event=push&status=success&per_page=10'),
    ]);
    const ci = selectAutoPwaCi(runs.workflow_runs);
    requireThat(ci, 'NO_APPROVED_PWA_CI');

    const [pulls, jobsRes, artsRes, commitsP1, commitsP2] = await Promise.all([
      ghApi(repoName, token, '/commits/' + ci.head_sha + '/pulls'),
      ghApi(repoName, token, '/actions/runs/' + ci.id + '/jobs?per_page=100'),
      ghApi(repoName, token, '/actions/runs/' + ci.id + '/artifacts?per_page=20'),
      ghApi(repoName, token, `/commits?sha=${ci.head_sha}&per_page=100&page=1`),
      ghApi(repoName, token, `/commits?sha=${ci.head_sha}&per_page=100&page=2`),
    ]);
    const artifact = (artsRes.artifacts || []).find(a => a.name === 'pwa-comercial-' + ci.head_sha);
    const release = buildAutoPwaRelease({repo: repoInfo, ci, jobs: jobsRes.jobs, artifact, pulls});

    const ancestorShas = [...(commitsP1 || []), ...(commitsP2 || [])]
      .map(c => c?.sha)
      .filter(s => SHA.test(s || '') && s !== release.application_sha);
    output('ancestor_shas=' + JSON.stringify(ancestorShas));

    if (SHORT_OR_FULL_SHA.test(productionSha) && UUID.test(deploymentId)) {
      if (release.application_sha === productionSha || release.application_sha.startsWith(productionSha)) {
        output('action=current');
        output('application_sha=' + release.application_sha);
        report('ALREADY_CURRENT_NO_WRITE', release.application_sha, deploymentId);
        return;
      }
      const comparison = await ghApi(repoName, token, `/compare/${productionSha}...${release.application_sha}?per_page=1`);
      validatePwaForward(release.application_sha, productionSha, comparison);
    }

    const redir = await ghApi(repoName, token, `/actions/artifacts/${release.artifact_id}/zip`, true);
    requireThat(redir.status === 302, 'ARTIFACT_REDIRECT');
    const url = new URL(redir.headers.get('location'));
    requireThat(
      url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        (url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.actions.githubusercontent.com')),
      'ARTIFACT_HOST',
    );
    const zipRes = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(120000)});
    requireThat(zipRes.ok, 'DOWNLOAD_HTTP_' + zipRes.status);
    const size = Number(zipRes.headers.get('content-length'));
    requireThat(size > 0 && size <= 100 * 1024 * 1024, 'DOWNLOAD_SIZE');
    const data = Buffer.from(await zipRes.arrayBuffer());
    requireThat(data.length === size && sha256Hex(data) === release.artifact_digest, 'DOWNLOAD_HASH');

    // Validate the entire ZIP structure and file hashes in memory before sealing
    extractAndVerifyPwaZip(data, release, null);

    const aad = `${runId}:${runAttempt}:${release.application_sha}:${release.artifact_digest}`;
    const sealed = sealArtifact(data, publicKey, aad);
    mkdirSync('.private', {recursive: true, mode: 0o700});
    writeFileSync('.private/sealed-pwa.bin', sealed, {mode: 0o600});

    output('action=publish');
    output('application_sha=' + release.application_sha);
    output('ci_run_id=' + release.ci_run_id);
    output('ci_attempt=' + release.ci_attempt);
    output('artifact_digest=' + release.artifact_digest);
    output('cache_key=pwa-sealed-' + runId + '-' + runAttempt + '-' + release.application_sha);
    console.log(`Automatic PWA candidate ${release.application_sha} derived from private main evidence (merged PR #${release.pr}) and sealed.`);
  } else if (op === 'publish') {
    const token = process.env.CF_PAGES_PUBLISH_TOKEN;
    const account = process.env.ACCOUNT_ID;
    const deploymentId = process.env.DEPLOYMENT_ID || '';
    const sealedKey = process.env.SEALED_KEY;
    const applicationSha = process.env.APPLICATION_SHA;
    const ciRunId = Number(process.env.CI_RUN_ID);
    const ciAttempt = Number(process.env.CI_ATTEMPT || '1');
    const artifactDigest = process.env.ARTIFACT_DIGEST;
    const ancestorShas = JSON.parse(process.env.ANCESTOR_SHAS || '[]');
    requireThat(
      token &&
        /^[a-f0-9]{32}$/.test(account || '') &&
        sealedKey &&
        SHA.test(applicationSha || '') &&
        Number.isSafeInteger(ciRunId) &&
        ciRunId > 0 &&
        HASH.test(artifactDigest || '') &&
        Array.isArray(ancestorShas),
      'PUBLISH_INPUT_INVALID',
    );

    const before = await getVerifiedPagesProject(token, account, project);
    if (before.sha === applicationSha || applicationSha.startsWith(before.sha)) {
      report('ALREADY_CURRENT_NO_WRITE', applicationSha, before.deployment.id);
      return;
    }
    if (UUID.test(deploymentId)) {
      requireThat(before.deployment.id === deploymentId, 'DEPLOYMENT_CHANGED_CONCURRENTLY');
    }
    requireThat(
      ancestorShas.some(s => typeof s === 'string' && (s === before.sha || s.startsWith(before.sha))),
      'CANDIDATE_NOT_AHEAD_OF_PRODUCTION',
    );

    const context = `${runId}:${runAttempt}:${project}`;
    const aad = `${runId}:${runAttempt}:${applicationSha}:${artifactDigest}`;
    const sealedBuffer = readFileSync('.private/sealed-pwa.bin');
    const zipBuffer = unsealArtifact(sealedBuffer, sealedKey, token, context, aad);
    requireThat(sha256Hex(zipBuffer) === artifactDigest, 'UNSEALED_DIGEST_MISMATCH');

    const distDir = resolve('.private/pwa-dist');
    extractAndVerifyPwaZip(
      zipBuffer,
      {application_sha: applicationSha, ci_run_id: ciRunId, ci_attempt: ciAttempt},
      distDir,
    );

    const cli = spawnSync(
      process.execPath,
      [
        'node_modules/wrangler/bin/wrangler.js',
        'pages',
        'deploy',
        distDir,
        `--project-name=${project}`,
        '--branch=main',
        `--commit-hash=${applicationSha}`,
        '--commit-dirty=false',
        '--no-bundle',
      ],
      {
        encoding: 'utf8',
        timeout: 300000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: token.trim(),
          CLOUDFLARE_ACCOUNT_ID: account,
          CI: 'true',
          WRANGLER_SEND_METRICS: 'false',
          WRANGLER_HIDE_BANNER: 'true',
          WRANGLER_LOG_SANITIZE: 'true',
        },
      },
    );

    let after = null;
    for (let attempt = 0; attempt < 18; attempt++) {
      const state = await cfApi(token, `/accounts/${account}/pages/projects/${project}`);
      const d = state?.canonical_deployment;
      const dSha = d?.deployment_trigger?.metadata?.commit_hash || '';
      if (
        d?.id &&
        d.id !== before.deployment.id &&
        d.latest_stage?.status === 'success' &&
        (dSha === applicationSha || applicationSha.startsWith(dSha))
      ) {
        after = d;
        break;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    requireThat(after && UUID.test(after.id), 'PWA_DEPLOYMENT_UNCERTAIN_DO_NOT_REPEAT');

    const originList = JSON.parse(process.env.PWA_ORIGINS || '["https://app.coloxi.net"]');
    requireThat(
      originList.length > 0 &&
        originList.every(s => {
          try {
            const u = new URL(s);
            return u.protocol === 'https:' && u.origin === s && !u.username && !u.password;
          } catch {
            return false;
          }
        }),
      'PWA_ORIGINS_INVALID',
    );

    let regression = false;
    for (const origin of originList) {
      const rootRes = await fetch(origin + '/', {redirect: 'follow', signal: AbortSignal.timeout(20000)});
      const swRes = await fetch(origin + '/sw.js', {redirect: 'follow', signal: AbortSignal.timeout(20000)});
      const swCache = swRes.headers.get('cache-control') || '';
      if (!rootRes.ok || !swRes.ok || !swCache.includes('must-revalidate')) {
        regression = true;
      }
    }
    if (regression) {
      const reverted = await cfApi(
        token,
        `/accounts/${account}/pages/projects/${project}/deployments/${before.deployment.id}/rollback`,
        'POST',
      );
      report('HTTP_REGRESSION_ROLLED_BACK', before.sha, reverted?.id || before.deployment.id);
      throw new Error('PWA_HTTP_REGRESSION');
    }

    report(cli.status === 0 ? 'PUBLISHED' : 'PUBLISHED_RECONCILED_CLI_ERROR', applicationSha, after.id);
  } else {
    throw new Error('PWA_OPERATION');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
