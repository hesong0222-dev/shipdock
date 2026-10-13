import { execFileSync } from 'node:child_process';

// Message for a 403/429 that is a rate limit (primary: remaining 0; secondary: retry-after), else null.
export function rateLimitMessage(status, headers, now = Date.now(), hasToken = false) {
  const h = (k) => (typeof headers.get === 'function' ? headers.get(k) : headers[k]);
  if (status !== 403 && status !== 429) return null;
  const retry = Number(h('retry-after'));
  const reset = Number(h('x-ratelimit-reset'));
  let secs;
  if (retry > 0) secs = retry;
  else if (h('x-ratelimit-remaining') === '0' && reset > 0) secs = Math.max(reset - now / 1000, 0);
  else return null;
  const mins = Math.max(Math.ceil(secs / 60), 1);
  return `GitHub API rate limit reached. Try again in about ${mins} min${hasToken ? '' : ', or set GITHUB_TOKEN (5000 requests/hour instead of 60)'}.`;
}

let cachedToken;
function token() {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  if (!cachedToken) {
    try {
      cachedToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch { cachedToken = null; }
  }
  return cachedToken;
}

export async function api(path) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'shipdock', 'x-github-api-version': '2022-11-28' };
  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch('https://api.github.com' + path, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(rateLimitMessage(res.status, res.headers, Date.now(), !!t) || `GitHub API ${res.status} for ${path}`);
  return res.json();
}

export function parseRepo(input) {
  const m = input.trim().replace(/\.git$/, '').match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+)/);
  if (!m) throw new Error(`Cannot parse repo: ${input}`);
  return `${m[1]}/${m[2]}`;
}

export async function fetchRelease(full, tag) {
  const [repo, release] = await Promise.all([
    api(`/repos/${full}`),
    api(tag ? `/repos/${full}/releases/tags/${encodeURIComponent(tag)}` : `/repos/${full}/releases/latest`),
  ]);
  if (!repo) throw new Error(`Repo not found: ${full}`);
  if (!release) throw new Error(`No ${tag ? `release tagged ${tag}` : 'published release'} in ${full}`);
  return { repo, release };
}
