import { readFileSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { download, sha256 } from './archive.mjs';

// Pull (url, sha256) pairs out of the manifests shipdock writes.
export function extractPairs(file, text) {
  if (file.endsWith('.rb')) {
    return [...text.matchAll(/url "([^"]+)"\s*\n\s*sha256 "([0-9a-f]{64})"/g)].map((m) => ({ url: m[1], hash: m[2] }));
  }
  if (file.endsWith('.json')) {
    const m = JSON.parse(text);
    return [m, ...Object.values(m.architecture || {})].filter((x) => x.url && x.hash).map((x) => ({ url: x.url.replace(/#.*$/, ''), hash: x.hash }));
  }
  if (/\.ya?ml$/.test(file)) {
    const val = (l) => { const v = l.slice(l.indexOf(':') + 1).trim(); return v.startsWith('"') ? JSON.parse(v) : v; };
    const lines = text.split('\n');
    const urls = lines.filter((l) => /^\s*InstallerUrl:/.test(l)).map(val);
    const hashes = lines.filter((l) => /^\s*InstallerSha256:/.test(l)).map(val);
    return urls.map((url, i) => ({ url, hash: hashes[i] || '' }));
  }
  return [];
}

export async function verifyHashes(dir) {
  const files = readdirSync(dir).filter((f) => /\.(rb|json|ya?ml)$/.test(f));
  const results = [];
  for (const f of files) {
    for (const { url, hash } of extractPairs(f, readFileSync(join(dir, f), 'utf8'))) {
      try {
        const actual = sha256(await download(url));
        results.push({ file: f, url, ok: actual === hash.toLowerCase(), detail: actual === hash.toLowerCase() ? '' : `got ${actual}` });
      } catch (e) {
        results.push({ file: f, url, ok: false, detail: e.message });
      }
    }
  }
  return results;
}

// Run `brew audit --strict` on each formula inside a throwaway local tap, then remove the tap.
export function brewAudit(dir) {
  const has = spawnSync('brew', ['--version'], { stdio: 'ignore' });
  if (has.error || has.status !== 0) return { skipped: 'brew not found' };
  const formulas = readdirSync(dir).filter((f) => f.endsWith('.rb'));
  if (!formulas.length) return { skipped: 'no .rb formula in directory' };
  const env = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1', HOMEBREW_NO_ENV_HINTS: '1' };
  const tap = `shipdock/verify${process.pid}`;
  const brew = (args) => spawnSync('brew', args, { env, encoding: 'utf8' });
  const made = brew(['tap-new', '--no-git', tap]);
  if (made.status !== 0) return { skipped: `brew tap-new failed: ${made.stderr.trim()}` };
  const results = [];
  try {
    const formulaDir = join(execFileSync('brew', ['--repository', tap], { env, encoding: 'utf8' }).trim(), 'Formula');
    mkdirSync(formulaDir, { recursive: true });
    for (const f of formulas) {
      copyFileSync(join(dir, f), join(formulaDir, f));
      const r = brew(['audit', '--strict', '--formula', `${tap}/${f.replace(/\.rb$/, '')}`]);
      results.push({ file: f, ok: r.status === 0, output: (r.stdout + r.stderr).trim() });
    }
  } finally {
    brew(['untap', '--force', tap]);
  }
  return { tap, results };
}
