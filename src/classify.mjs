// Classify GitHub release assets by OS, architecture and format, then decide
// which asset each package manager would use.

const FORMATS = [
  ['tar.gz', /\.tar\.gz$/], ['tgz', /\.tgz$/], ['zip', /\.zip$/], ['deb', /\.deb$/], ['rpm', /\.rpm$/],
  ['msi', /\.msi$/], ['exe', /\.exe$/], ['dmg', /\.dmg$/], ['pkg', /\.pkg$/], ['AppImage', /\.appimage$/],
];

const SKIP = [
  ['checksum', /\.(sha\d*|md5)(sums?)?$|(^|[-_.])(checksums?|sha\d+sums?)(\.txt)?$/],
  ['signature', /\.(sig|asc|pem|minisig|sigstore(\.json)?|cert|crt|intoto\.jsonl)$/],
  ['sbom', /(^|[-_.])sbom([-_.]|$)|\.(spdx|cdx)(\.json)?$/],
  ['source', /(^|[-_.])(src|source|sources|vendor|vendored)([-_.]|$)/],
];

// Match a token that is not glued to other letters/digits ("arm64" in "linux_arm64.tar.gz", not "farm64").
const tok = (alts) => new RegExp(`(^|[^a-z0-9])(${alts})(?=[^a-z0-9]|$)`);
const AMD64 = tok('x86_64|x86-64|amd64|x64');
const ARM64 = tok('arm64|aarch64|arm64e');
const UNIVERSAL = tok('universal2?|all');
const WIN_GNU = tok('gnu|gnullvm|mingw');

function osOf(n, format) {
  if (/android|freebsd|openbsd|netbsd|illumos|solaris|dragonfly/.test(n)) return null;
  if (/darwin|macos|apple|osx/.test(n) || tok('mac').test(n) || format === 'dmg' || format === 'pkg') return 'darwin';
  if (/windows/.test(n) || tok('win|win32|win64').test(n) || format === 'msi' || format === 'exe') return 'windows';
  if (/linux/.test(n) || ['deb', 'rpm', 'AppImage'].includes(format)) return 'linux';
  return null;
}

export function classifyAsset(asset) {
  const n = asset.name.toLowerCase();
  const base = { name: asset.name, url: asset.browser_download_url, size: asset.size, digest: asset.digest || null };
  for (const [reason, re] of SKIP) if (re.test(n)) return { ...base, skip: reason };
  const format = (FORMATS.find(([, re]) => re.test(n)) || [])[0];
  if (!format) return { ...base, skip: 'unknown format' };
  const os = osOf(n, format);
  if (!os) return { ...base, skip: 'unsupported os' };
  const arch = ARM64.test(n) ? 'arm64' : AMD64.test(n) ? 'amd64' : os === 'darwin' && UNIVERSAL.test(n) ? 'universal' : null;
  if (!arch) return { ...base, skip: 'unsupported arch' };
  return { ...base, os, arch, format, musl: /musl/.test(n), winGnu: os === 'windows' && WIN_GNU.test(n) };
}

export const MANAGERS = {
  homebrew: {
    label: 'Homebrew', formats: ['tar.gz', 'tgz', 'zip'],
    slots: [['darwin', 'arm64'], ['darwin', 'amd64'], ['linux', 'arm64'], ['linux', 'amd64']],
    effect: (os, arch) => `Homebrew formula will have no Hardware::CPU.${arch === 'arm64' ? 'arm?' : 'intel?'} block in ${os === 'darwin' ? 'on_macos' : 'on_linux'}`,
  },
  scoop: {
    label: 'Scoop', formats: ['zip', 'exe'],
    slots: [['windows', 'amd64'], ['windows', 'arm64']],
    effect: (os, arch) => `Scoop manifest will have no ${arch === 'arm64' ? 'arm64' : '64bit'} architecture`,
  },
  winget: {
    label: 'winget', formats: ['zip', 'msi', 'exe'],
    // A singleton manifest holds exactly one installer: x64, else arm64.
    single: true,
    slots: [['windows', 'amd64'], ['windows', 'arm64']],
    effect: (os, arch) => `winget manifest will have no ${arch === 'arm64' ? 'arm64' : 'x64'} installer`,
  },
};

// Lower is better: exact arch over universal, earlier format, glibc over musl, msvc over mingw.
const rank = (m, arch) => (a) => [a.arch === arch ? 0 : 1, m.formats.indexOf(a.format), a.musl ? 1 : 0, a.winGnu ? 1 : 0];
const cmp = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

export function pickFor(assets, key) {
  const m = MANAGERS[key];
  const picks = {}, missing = [];
  for (const [os, arch] of m.slots) {
    const forSlot = assets.filter((a) => a.os === os && (a.arch === arch || (os === 'darwin' && a.arch === 'universal')));
    const usable = forSlot.filter((a) => m.formats.includes(a.format));
    const r = rank(m, arch);
    usable.sort((a, b) => cmp(r(a), r(b)));
    picks[`${os}-${arch}`] = usable[0] || null;
    if (!usable[0]) {
      const other = [...new Set(forSlot.map((a) => a.format))];
      missing.push(`${os} ${arch} asset missing → ${m.effect(os, arch)}${other.length ? ` (found ${other.join('/')}, not usable here)` : ''}`);
    }
  }
  const n = Object.values(picks).filter(Boolean).length;
  if (m.single && n) {
    const keep = Object.keys(picks).find((k) => picks[k]);
    for (const k of Object.keys(picks)) if (k !== keep) picks[k] = null;
    return { label: m.label, status: 'ready', picks, missing: [`singleton manifest: one installer only (${keep})`] };
  }
  return { label: m.label, status: n === m.slots.length ? 'ready' : n ? 'partial' : 'not possible', picks, missing };
}

export const NOT_COVERED = [
  'Homebrew Casks (.dmg/.pkg apps)',
  'Flatpak / Snap / AppImage hubs',
  'publishing to apt/yum (deb/rpm) repositories',
  'code signing and notarization',
  'real install tests (nothing is installed)',
  'submitting to homebrew-core, Scoop buckets or winget-pkgs',
];

export function plan(full, release) {
  const all = release.assets.map(classifyAsset);
  const assets = all.filter((a) => !a.skip);
  const managers = Object.fromEntries(Object.keys(MANAGERS).map((k) => [k, pickFor(assets, k)]));
  return {
    repo: full, tag: release.tag_name, version: release.tag_name.replace(/^v/, ''),
    assets, skipped: all.filter((a) => a.skip), managers, notCovered: NOT_COVERED,
  };
}

export function renderPlan(p) {
  const L = [`shipdock plan · ${p.repo} @ ${p.tag}`, '', `Assets (${p.assets.length} usable, ${p.skipped.length} skipped)`];
  for (const a of p.assets) L.push(`  ${a.os.padEnd(8)}${a.arch.padEnd(10)}${a.format.padEnd(9)}${a.name}${a.musl ? '  (musl)' : ''}`);
  for (const a of p.skipped) L.push(`  ${'-'.padEnd(27)}${a.name}  [${a.skip}]`);
  L.push('', `${'Manager'.padEnd(10)}${'Status'.padEnd(14)}Uses`);
  for (const m of Object.values(p.managers)) {
    const uses = Object.entries(m.picks).filter(([, a]) => a).map(([slot, a]) => `${slot}: ${a.name}`);
    L.push(`${m.label.padEnd(10)}${m.status.padEnd(14)}${uses[0] || '-'}`);
    for (const u of uses.slice(1)) L.push(`${''.padEnd(24)}${u}`);
    for (const x of m.missing) L.push(`${''.padEnd(24)}! ${x}`);
  }
  L.push('', 'Not covered by shipdock:', ...p.notCovered.map((x) => `  - ${x}`));
  return L.join('\n');
}
