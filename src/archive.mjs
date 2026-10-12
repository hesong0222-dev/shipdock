import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const MAX_DOWNLOAD = 300 * 1024 * 1024;

export async function download(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'shipdock' } });
  if (!res.ok) throw new Error(`download ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Entries of a tar.gz via the system tar: names from -tzf, modes from the first column of -tzvf (same order).
function tarEntries(buf) {
  const run = (flags) => execFileSync('tar', [flags, '-'], { input: buf, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);
  const names = run('-tzf'), long = run('-tzvf');
  return names.map((path, i) => {
    const mode = (long[i] || '').split(/\s+/)[0];
    return { path, dir: mode[0] === 'd' || path.endsWith('/'), link: mode[0] === 'l', exec: mode[0] === '-' && /x/.test(mode.slice(1)) };
  });
}

// Entries of a zip from its central directory (no ZIP64; assets over 300 MB are never opened).
function zipEntries(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip file');
  const out = [];
  let p = buf.readUInt32LE(e + 16);
  for (let i = buf.readUInt16LE(e + 10); i > 0 && buf.readUInt32LE(p) === 0x02014b50; i--) {
    const nameLen = buf.readUInt16LE(p + 28), skip = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const path = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    const unixMode = buf[p + 5] === 3 ? buf.readUInt32LE(p + 38) >>> 16 : 0;
    out.push({ path, dir: path.endsWith('/'), link: (unixMode & 0o170000) === 0o120000, exec: (unixMode & 0o111) !== 0 });
    p += 46 + nameLen + skip;
  }
  return out;
}

export function listArchive(buf, format) {
  return format === 'zip' ? zipEntries(buf) : tarEntries(buf);
}

// Find the executable: a single top-level directory is reported as `root` (Homebrew strips it,
// Scoop needs it as extract_dir). Prefer an executable named like the repo, else the only one.
export function findBinary(entries, name, windows) {
  const files = entries.map((e) => ({ ...e, path: e.path.replace(/^\.\//, '') })).filter((e) => e.path && !e.dir && !e.link);
  const tops = new Set(files.map((f) => f.path.split('/')[0]));
  const root = tops.size === 1 && files.every((f) => f.path.includes('/')) ? [...tops][0] : '';
  const cands = files.filter((f) => (windows ? /\.exe$/i.test(f.path) : f.exec));
  const base = (f) => f.path.split('/').pop().replace(/\.exe$/i, '').toLowerCase();
  const hit = cands.find((f) => base(f) === name.toLowerCase()) || (cands.length === 1 ? cands[0] : null);
  return { root, bin: hit ? hit.path.slice(root ? root.length + 1 : 0) : null };
}

// Hash and inspect one classified asset. Uses the API `digest` when present; downloads
// archives to look inside, and anything without a digest to hash it.
export async function inspect(asset, name) {
  const digest = asset.digest && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : null;
  const isArchive = ['tar.gz', 'tgz', 'zip'].includes(asset.format);
  if (!isArchive && digest) return { sha256: digest, root: '', bin: null, warnings: [] };
  if (asset.size > MAX_DOWNLOAD) {
    return { sha256: digest, root: '', bin: null, warnings: [`${asset.name} is over 300 MB; not downloaded${digest ? '' : ', no hash available'}`] };
  }
  const buf = await download(asset.url);
  const hash = sha256(buf);
  if (digest && digest !== hash) throw new Error(`${asset.name}: downloaded sha256 ${hash} does not match API digest ${digest}`);
  if (!isArchive) return { sha256: hash, root: '', bin: null, warnings: [] };
  return { sha256: hash, ...findBinary(listArchive(buf, asset.format), name, asset.os === 'windows'), warnings: [] };
}
