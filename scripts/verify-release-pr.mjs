import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadRelease, requireThat } from './policy.mjs';

export function getCodeOwners() {
  const codeowners = readFileSync('.github/CODEOWNERS', 'utf8');
  const owners = [];
  for (const line of codeowners.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      for (const token of trimmed.split(/\s+/)) {
        if (token.startsWith('@')) {
          owners.push(token.slice(1).toLowerCase());
        }
      }
    }
  }
  return owners;
}

export function getLastReleaseCommit() {
  try {
    const hash = execFileSync('git', ['log', '-1', '--format=%H', 'releases/web.json'], { encoding: 'utf8' }).trim();
    if (/^[a-f0-9]{40}$/.test(hash)) return hash;
  } catch {
    // Si no hay git disponible o el checkout es superficial
  }
  return null;
}

export async function verifyReleasePR({
  repo = process.env.GITHUB_REPOSITORY || 'infocoloxi-bit/coloxi-control-publicacion',
  token = process.env.GITHUB_TOKEN,
  release = loadRelease(),
  commitSha = getLastReleaseCommit(),
  fetchFn = fetch,
} = {}) {
  // El bootstrap histórico tiene evidencia criptográfica inmutable fijada en validateRelease
  if (release.bootstrap_evidence) {
    console.log('Release con evidencia de bootstrap criptográfico. Verificación de PR omitida para bootstrap.');
    return true;
  }

  requireThat(commitSha, 'RELEASE_COMMIT_NOT_FOUND');
  requireThat(repo === 'infocoloxi-bit/coloxi-control-publicacion', 'INVALID_CONTROL_REPO');

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'coloxi-control-verifier',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const allowedOwners = getCodeOwners();
  requireThat(allowedOwners.length > 0, 'NO_CODEOWNERS_CONFIGURED');

  const root = `https://api.github.com/repos/${repo}`;
  const pullsRes = await fetchFn(`${root}/pulls?state=closed&base=main&per_page=50`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  requireThat(pullsRes.ok, `PULLS_API_HTTP_${pullsRes.status}`);
  const pulls = await pullsRes.json();

  const matchingPR = pulls.find(p =>
    p.merged_at && (p.merge_commit_sha === commitSha || p.head?.sha === commitSha)
  );
  requireThat(matchingPR, 'DIRECT_PUSH_DETECTED_NO_MERGED_PR');

  const reviewsRes = await fetchFn(`${root}/pulls/${matchingPR.number}/reviews`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  requireThat(reviewsRes.ok, `REVIEWS_API_HTTP_${reviewsRes.status}`);
  const reviews = await reviewsRes.json();

  const approvedByCodeOwner = reviews.some(r =>
    r.state === 'APPROVED' && allowedOwners.includes(r.user?.login?.toLowerCase())
  );
  requireThat(approvedByCodeOwner, 'PR_MISSING_CODEOWNER_APPROVAL');

  console.log(`Release commit ${commitSha} verificado: fusionado via PR #${matchingPR.number} con aprobación de CODEOWNERS (${allowedOwners.join(', ')}).`);
  return { pr: matchingPR.number, commit: commitSha };
}

if (process.argv[1]?.endsWith('verify-release-pr.mjs')) {
  await verifyReleasePR();
}
