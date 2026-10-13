import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyAsset, plan } from '../src/classify.mjs';

const release = JSON.parse(readFileSync(new URL('./fixtures/release.json', import.meta.url), 'utf8'));
const c = (name) => classifyAsset({ name, size: 1, browser_download_url: `https://x/${name}` });
const pick = ({ os, arch, format, skip }) => (skip ? { skip } : { os, arch, format });

test('arch aliases: aarch64/arm64 are arm64, x86_64/amd64/x64 are amd64', () => {
  assert.deepEqual(pick(c('tool-aarch64-apple-darwin.tar.gz')), { os: 'darwin', arch: 'arm64', format: 'tar.gz' });
  assert.deepEqual(pick(c('tool_Linux_arm64.tgz')), { os: 'linux', arch: 'arm64', format: 'tgz' });
  assert.deepEqual(pick(c('tool-x86_64-unknown-linux-gnu.tar.gz')), { os: 'linux', arch: 'amd64', format: 'tar.gz' });
  assert.deepEqual(pick(c('tool_1.0_amd64.deb')), { os: 'linux', arch: 'amd64', format: 'deb' });
  assert.deepEqual(pick(c('tool-win-x64.exe')), { os: 'windows', arch: 'amd64', format: 'exe' });
});

test('32-bit arm and i686 are not mistaken for arm64/amd64', () => {
  assert.equal(c('tool-arm-unknown-linux-gnueabihf.tar.gz').skip, 'unsupported arch');
  assert.equal(c('tool-linux_armv7.tar.gz').skip, 'unsupported arch');
  assert.equal(c('tool-i686-pc-windows-msvc.zip').skip, 'unsupported arch');
});

test('universal mac builds count for both mac architectures', () => {
  assert.equal(c('Tool-macos-universal.zip').arch, 'universal');
  assert.equal(c('tool_darwin_all.tar.gz').arch, 'universal');
  const p = plan('acme/tool', { tag_name: 'v1.0.0', assets: [{ name: 'tool-1.0.0-macos-universal.tar.gz', size: 1, browser_download_url: 'u' }] });
  assert.equal(p.managers.homebrew.picks['darwin-arm64'].name, 'tool-1.0.0-macos-universal.tar.gz');
  assert.equal(p.managers.homebrew.picks['darwin-amd64'].name, 'tool-1.0.0-macos-universal.tar.gz');
});

test('musl and mingw builds are flagged and only used when nothing else exists', () => {
  assert.equal(c('tool-x86_64-unknown-linux-musl.tar.gz').musl, true);
  assert.equal(c('tool-x86_64-pc-windows-gnu.zip').winGnu, true);
  const p = plan('acme/tool', release);
  assert.equal(p.managers.homebrew.picks['linux-amd64'].name, 'tool-v1.2.0-x86_64-unknown-linux-gnu.tar.gz');
  assert.equal(p.managers.scoop.picks['windows-amd64'].name, 'tool-v1.2.0-x86_64-pc-windows-msvc.zip');
  const onlyMusl = plan('acme/tool', { tag_name: 'v1', assets: [{ name: 'tool-x86_64-unknown-linux-musl.tar.gz', size: 1, browser_download_url: 'u' }] });
  assert.equal(onlyMusl.managers.homebrew.picks['linux-amd64'].name, 'tool-x86_64-unknown-linux-musl.tar.gz');
});

test('checksums, signatures, SBOMs, source archives and non-target OSes are skipped', () => {
  assert.equal(c('tool.tar.gz.sha256').skip, 'checksum');
  assert.equal(c('SHA256SUMS').skip, 'checksum');
  assert.equal(c('tool_1.0_checksums.txt').skip, 'checksum');
  assert.equal(c('tool.tar.gz.sig').skip, 'signature');
  assert.equal(c('tool.zip.minisig').skip, 'signature');
  assert.equal(c('tool.sbom.json').skip, 'sbom');
  assert.equal(c('tool-1.0.spdx.json').skip, 'sbom');
  assert.equal(c('tool-1.0-source.tar.gz').skip, 'source');
  assert.equal(c('tool-1.0-aarch64-linux-android.tar.gz').skip, 'unsupported os');
  assert.equal(c('tool_1.0_freebsd_amd64.tar.gz').skip, 'unsupported os');
});

test('format implies OS for deb/rpm/AppImage/msi/dmg', () => {
  assert.equal(c('tool-1.0.x86_64.rpm').os, 'linux');
  assert.equal(c('tool-1.0-amd64.AppImage').format, 'AppImage');
  assert.equal(c('tool-1.0-x64.msi').os, 'windows');
  assert.equal(c('Tool-1.0-arm64.dmg').os, 'darwin');
});

test('plan on the fixture: per-manager coverage and honest missing notes', () => {
  const p = plan('acme/tool', release);
  assert.equal(p.version, '1.2.0');
  assert.equal(p.assets.length, 8);
  assert.equal(p.skipped.length, 7);
  const brew = p.managers.homebrew;
  assert.equal(brew.status, 'partial');
  assert.equal(brew.picks['linux-arm64'], null);
  assert.deepEqual(brew.missing, ['linux arm64 asset missing → Homebrew formula will have no Hardware::CPU.arm? block in on_linux (found deb, not usable here)']);
  assert.equal(p.managers.scoop.status, 'partial');
  assert.match(p.managers.scoop.missing[0], /windows arm64 asset missing/);
  assert.equal(p.managers.winget.status, 'ready');
  assert.ok(p.notCovered.some((x) => /code signing/.test(x)));
});

test('tar.xz, bare executables and <os>64 names are classified (S1 field run)', () => {
  assert.deepEqual(pick(c('sed-aarch64-apple-darwin.tar.xz')), { os: 'darwin', arch: 'arm64', format: 'tar.xz' });
  assert.deepEqual(pick(c('xreferee-1.1.1-osx-arm64')), { os: 'darwin', arch: 'arm64', format: 'binary' });
  assert.deepEqual(pick(c('git-ai-linux-x64')), { os: 'linux', arch: 'amd64', format: 'binary' });
  assert.equal(c('install.sh').skip, 'unknown format');
  assert.deepEqual(pick(c('browserpass-darwin64-3.1.2.tar.gz')), { os: 'darwin', arch: 'amd64', format: 'tar.gz' });
  assert.deepEqual(pick(c('browserpass-linux64-3.1.2.tar.gz')), { os: 'linux', arch: 'amd64', format: 'tar.gz' });
  assert.deepEqual(pick(c('elinks-0.20.0-win64.zip')), { os: 'windows', arch: 'amd64', format: 'zip' });
});
