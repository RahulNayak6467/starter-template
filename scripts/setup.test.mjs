import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, test } from 'node:test';

let root;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'monorepo-setup-test-'));
  await mkdir(join(root, 'scripts'));
  await copyFile(new URL('./setup.mjs', import.meta.url), join(root, 'scripts/setup.mjs'));
  await writeFile(join(root, '.env.example'), 'NODE_ENV=development\n');
  await writeFile(join(root, '.env.test.example'), 'NODE_ENV=test\n');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = (cwd = root) =>
  execFileSync(process.execPath, [join(root, 'scripts/setup.mjs')], { cwd, encoding: 'utf8' });

test('creates both missing environment files from their examples', async () => {
  run();
  assert.equal(await readFile(join(root, '.env'), 'utf8'), 'NODE_ENV=development\n');
  assert.equal(await readFile(join(root, '.env.test'), 'utf8'), 'NODE_ENV=test\n');
});

test('preserves existing configuration on repeated setup', async () => {
  run();
  await writeFile(join(root, '.env'), 'CUSTOM=keep-development\n');
  await writeFile(join(root, '.env.test'), 'CUSTOM=keep-test\n');
  const output = run();
  assert.match(output, /Kept existing .env/);
  assert.equal(await readFile(join(root, '.env'), 'utf8'), 'CUSTOM=keep-development\n');
  assert.equal(await readFile(join(root, '.env.test'), 'utf8'), 'CUSTOM=keep-test\n');
});

test('creates only the missing file when the other has been customized', async () => {
  await writeFile(join(root, '.env'), 'CUSTOM=keep\n');
  run();
  assert.equal(await readFile(join(root, '.env'), 'utf8'), 'CUSTOM=keep\n');
  assert.equal(await readFile(join(root, '.env.test'), 'utf8'), 'NODE_ENV=test\n');
});

test('uses the project directory even when invoked from a different working directory', async () => {
  run(tmpdir());
  assert.equal(await readFile(join(root, '.env.test'), 'utf8'), 'NODE_ENV=test\n');
});
