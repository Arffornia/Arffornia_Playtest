// Unit tests for the pure parts of njs/pack.js (the nginx handlers are covered by smoke.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import pack from '../njs/pack.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const fx = (p) => fs.readFileSync(path.join(here, 'fixture', p), 'utf8');
const profile = pack.loadProfile(path.join(here, 'profile.test.json'));

test('retags only the listed github-releases entries', () => {
  const list = JSON.parse(fx('config/server/modList.json'));
  assert.equal(pack.retagMods(list, profile.mods, 'edge'), 1);
  const gh = list.mods['github-releases'];
  assert.equal(gh.find((m) => m.repoName === 'Arffornia_Mods').tag, 'edge');
  assert.equal(gh.find((m) => m.repoName === 'Other_Mod').tag, 'latest');
});

test('an empty tag keeps latest', () => {
  const list = JSON.parse(fx('config/server/modList.json'));
  assert.equal(pack.retagMods(list, profile.mods, ''), 0);
  assert.ok(list.mods['github-releases'].every((m) => m.tag === 'latest'));
});

test('rewrites every occurrence, and says when nothing changed', () => {
  assert.deepEqual(pack.rewriteText('a b a', [{ from: 'a', to: 'c' }]), { text: 'c b c', changed: true });
  assert.deepEqual(pack.rewriteText('x', [{ from: 'a', to: 'c' }]), { text: 'x', changed: false });
});

test('rules match the path and the kind', () => {
  assert.equal(pack.rulesFor(profile, 'server', 'config/arffornia-common.toml').length, 2);
  assert.equal(pack.rulesFor(profile, 'launcher', 'config/arffornia-common.toml'), null);
  assert.equal(pack.rulesFor(profile, 'server', 'config/other.toml'), null);
});

test('a missing profile falls back to the Arffornia mod and no rewrite', () => {
  const p = pack.loadProfile('/nonexistent/profile.json');
  assert.deepEqual(p.mods, [{ owner: 'Arffornia', repoName: 'Arffornia_Mods' }]);
  assert.deepEqual(p.files, []);
});

test('rehashes the rewritten files with SHA-1 and leaves the others', async () => {
  const idx = JSON.parse(fx('config/server/index.json'));
  const before = idx.files.map((f) => f.hash);
  const changed = await pack.rehashIndex(idx, profile, 'server', async (p) => fx(`config/server/storage/${p}`));
  assert.deepEqual(changed, ['config/arffornia-common.toml']);
  const expected = pack.rewriteText(fx('config/server/storage/config/arffornia-common.toml'),
    pack.rulesFor(profile, 'server', 'config/arffornia-common.toml')).text;
  assert.equal(idx.files[0].hash, crypto.createHash('sha1').update(expected).digest('hex'));
  assert.notEqual(idx.files[0].hash, before[0]);
  assert.equal(idx.files[1].hash, before[1]);
});

test('the fixture hashes match their files (same rule as the index generator)', () => {
  const idx = JSON.parse(fx('config/server/index.json'));
  for (const f of idx.files) assert.equal(pack.sha1(fx(`config/server/storage/${f.path}`)), f.hash);
});
