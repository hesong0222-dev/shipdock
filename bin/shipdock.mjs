#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRepo, fetchRelease } from '../src/github.mjs';
import { plan, renderPlan } from '../src/classify.mjs';
import { inspect } from '../src/archive.mjs';
import { renderFormula, renderScoop, renderWinget } from '../src/render.mjs';
import { verifyHashes, brewAudit } from '../src/verify.mjs';

const HELP = `shipdock — package-manager manifests from a GitHub Release, no config file

Usage:
  shipdock plan <owner/repo> [--tag vX.Y.Z] [--json]     what each package manager can get from the release
  shipdock generate <owner/repo> --out <dir> [--tag vX.Y.Z]   write Homebrew formula, Scoop and winget manifests
  shipdock verify <dir> [--brew]                         re-download every URL and check its sha256;
                                                         --brew also runs \`brew audit --strict\` in a temporary local tap

Auth: uses GITHUB_TOKEN / GH_TOKEN, or \`gh auth token\` if available (60 req/h without).
Generated files are drafts: review before submitting anywhere.`;

async function load(arg, tag) {
  const full = parseRepo(arg);
  const { repo, release } = await fetchRelease(full, tag);
  return { repo, p: plan(full, release) };
}

async function generate(arg, tag, out) {
  const { repo, p } = await load(arg, tag);
  const [owner, name] = p.repo.split('/');
  const spdx = repo.license && repo.license.spdx_id !== 'NOASSERTION' ? repo.license.spdx_id : null;
  const meta = { owner, repo: name, name: name.toLowerCase(), desc: repo.description, homepage: repo.html_url, license: spdx, licenseName: repo.license && repo.license.name, version: p.version };
  const active = Object.entries(p.managers).filter(([, m]) => m.status !== 'not possible');
  const assets = [...new Set(active.flatMap(([, m]) => Object.values(m.picks).filter(Boolean)))];
  const info = {};
  await Promise.all(assets.map(async (a) => { info[a.name] = await inspect(a, meta.name); }));
  for (const i of Object.values(info)) for (const w of i.warnings) console.error(`! ${w}`);
  mkdirSync(out, { recursive: true });
  const files = { homebrew: [`${meta.name}.rb`, renderFormula], scoop: [`${meta.name}.json`, renderScoop], winget: [`${owner}.${name}.yaml`, renderWinget] };
  for (const [key, m] of Object.entries(p.managers)) {
    if (m.status === 'not possible') { console.log(`- ${m.label}: skipped (no usable asset)`); continue; }
    const [file, render] = files[key];
    writeFileSync(join(out, file), render(meta, m, info));
    console.log(`✓ ${m.label}: ${join(out, file)} (${m.status})`);
    for (const x of m.missing) console.log(`    ! ${x}`);
  }
  const todo = Object.entries(info).filter(([n, i]) => /\.(tar\.gz|tgz|zip)$/i.test(n) && !i.bin).map(([n]) => n);
  if (todo.length) console.log(`! no executable found in: ${todo.join(', ')} — see the TODO line in the generated files`);
}

async function verify(dir, brew) {
  const hashes = await verifyHashes(dir);
  for (const r of hashes) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.file}  ${r.url}${r.detail ? `  (${r.detail})` : ''}`);
  if (!hashes.length) console.log('no url/sha256 pairs found');
  let failed = hashes.some((r) => !r.ok);
  if (brew) {
    const a = brewAudit(dir);
    if (a.skipped) console.log(`brew audit: skipped (${a.skipped})`);
    for (const r of a.results || []) {
      console.log(`brew audit --strict ${r.file}: ${r.ok ? 'pass' : 'FAIL'}`);
      if (r.output) console.log(r.output.replace(/^/gm, '    '));
      failed ||= !r.ok;
    }
  }
  if (failed) process.exitCode = 1;
}

async function main() {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
  if (!cmd || cmd === '-h' || cmd === '--help') return console.log(HELP);
  if (cmd === 'plan' && arg) {
    const { p } = await load(arg, opt('--tag'));
    return console.log(rest.includes('--json') ? JSON.stringify(p, null, 2) : renderPlan(p));
  }
  if (cmd === 'generate' && arg && opt('--out')) return generate(arg, opt('--tag'), opt('--out'));
  if (cmd === 'verify' && arg) return verify(arg, rest.includes('--brew'));
  console.log(HELP);
  process.exitCode = 1;
}

main().catch((e) => { console.error(e.message); process.exit(1); });
