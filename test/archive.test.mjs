import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findBinary } from '../src/archive.mjs';

const f = (path, exec = false) => ({ path, dir: false, link: false, exec });

test('findBinary: a repo-named file with a platform suffix is found even without the executable bit', () => {
  const r = findBinary([f('zigscient-aarch64-macos'), f('README.md'), f('LICENSE'), f('LICENSE-ZLS')], 'zigscient', false);
  assert.deepEqual(r, { root: '', bin: 'zigscient-aarch64-macos', chmod: true });
  assert.equal(findBinary([f('tool/tool', true), f('tool/README.md')], 'tool', false).chmod, false);
});
