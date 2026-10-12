import { execFileSync } from 'node:child_process';

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
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}${res.status === 403 ? ' (rate limit? set GITHUB_TOKEN)' : ''}`);
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
