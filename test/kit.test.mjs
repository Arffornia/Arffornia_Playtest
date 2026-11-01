// CLI tests against an in-memory GitHub (no network). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../kit/playtest.mjs';
import { reap } from '../kit/reap.mjs';
import { makeGh, makeStore, GhError } from '../kit/lib/github.mjs';
import { serializeEnv, parseEnv, validateEnv, buildEnv, parseRef, extendEnv, MAX_TTL_MS } from '../kit/lib/slots.mjs';
import { buildCard, loadSessions } from '../kit/lib/card.mjs';

const NOW = Date.parse('2026-11-02T18:00:00Z');
const sha = (c) => c.repeat(40).slice(0, 40);
const PT = 'Arffornia/Arffornia_Playtest';

// ------------------------------------------------------------------ fake GitHub
function fakeGitHub() {
  const prs = {};
  const checks = {};
  const releases = {};
  const branches = { envs: {} }; // branch -> path -> { text, sha }
  const calls = [];
  let blob = 0;
  const addPr = (slug, n, { head = sha(String(n % 10)), state = 'open', fork = false, merged = false, title = `PR ${n}` } = {}) => {
    prs[`${slug}#${n}`] = { number: n, title, state, merged_at: merged ? '2026-11-01T00:00:00Z' : null, head: { sha: head, repo: { full_name: fork ? 'someone/fork' : slug } }, base: { repo: { full_name: slug } } };
    checks[`${slug}@${head}`] = [{ name: 'ci', status: 'completed', conclusion: 'success' }];
  };
  const transport = (method, path, body) => {
    calls.push([method, path]);
    const p = path.replace(/\?.*$/, '');
    let m;
    if (method === 'GET' && p === 'user') return { login: 'TheGostsniperfr' };
    if ((m = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(p)) && method === 'GET') {
      const pr = prs[`${m[1]}#${m[2]}`];
      if (!pr) throw new GhError('Not Found (HTTP 404)', 404);
      return pr;
    }
    if ((m = /^repos\/([^/]+\/[^/]+)\/commits\/(\w+)\/check-runs$/.exec(p))) return { check_runs: checks[`${m[1]}@${m[2]}`] || [] };
    if ((m = /^repos\/([^/]+\/[^/]+)\/releases\/tags\/(.+)$/.exec(p))) {
      const r = releases[`${m[1]}@${decodeURIComponent(m[2])}`];
      if (!r) throw new GhError('Not Found (HTTP 404)', 404);
      return r;
    }
    if ((m = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(p)) && method === 'POST') return { id: 1 };
    if (!p.startsWith(`repos/${PT}/`)) throw new GhError(`unexpected ${method} ${path}`, 500);
    const rest = p.slice(`repos/${PT}/`.length);
    const ref = (/[?&]ref=([^&]+)/.exec(path) || [])[1];
    if (method === 'GET' && rest === 'contents/envs') {
      const files = Object.keys(branches[decodeURIComponent(ref)] || {});
      if (!files.length) throw new GhError('Not Found (HTTP 404)', 404);
      return files.map((f) => ({ type: 'file', name: f.replace('envs/', '') }));
    }
    if ((m = /^contents\/(envs\/[\w-]+\.yaml)$/.exec(rest))) {
      const file = m[1];
      if (method === 'GET') {
        const f = (branches[decodeURIComponent(ref)] || {})[file];
        if (!f) throw new GhError('Not Found (HTTP 404)', 404);
        return { sha: f.sha, content: Buffer.from(f.text).toString('base64') };
      }
      const br = branches[body.branch];
      if (!br) throw new GhError('Branch not found (HTTP 404)', 404);
      const cur = br[file];
      if (method === 'PUT') {
        if (cur && !body.sha) throw new GhError('"sha" wasn\'t supplied (HTTP 422)', 422);
        if (cur && body.sha !== cur.sha) throw new GhError('does not match (HTTP 409)', 409);
        if (!cur && body.sha) throw new GhError('Not Found (HTTP 404)', 404);
        br[file] = { text: Buffer.from(body.content, 'base64').toString('utf8'), sha: `blob${++blob}` };
        return { commit: { sha: `c${blob}` } };
      }
      if (method === 'DELETE') {
        if (!cur || body.sha !== cur.sha) throw new GhError('does not match (HTTP 409)', 409);
        delete br[file];
        return { commit: { sha: `d${blob}` } };
      }
    }
    if (method === 'GET' && rest === 'git/ref/heads/envs') return { object: { sha: 'envhead' } };
    if (method === 'POST' && rest === 'git/refs') { branches[body.ref.replace('refs/heads/', '')] = { ...branches.envs }; return {}; }
    if (method === 'POST' && rest === 'pulls') return { html_url: `https://github.com/${PT}/pull/7` };
    throw new GhError(`unexpected ${method} ${path}`, 500);
  };
  return { transport, prs, checks, releases, branches, calls, addPr };
}

function ctxFor(fake, { cluster = true, images = true, now = NOW } = {}) {
  const gh = makeGh(fake.transport);
  const logs = [];
  const opened = [];
  return {
    gh,
    store: makeStore(gh),
    now: () => now,
    log: (...a) => logs.push(a.join(' ')),
    open: (u) => opened.push(u),
    login: () => 'TheGostsniperfr',
    pollMs: 0,
    health: {
      clusterUp: async () => ({ ok: cluster, detail: cluster ? 'staging answered 200' : 'staging unreachable (ECONNREFUSED)' }),
      imageExists: async (image, tag) => ({ ok: images, detail: `${image}:${tag}${images ? '' : ' is not published'}` }),
      slotUp: async () => ({ ok: true, detail: 'HTTP 200' }),
    },
    logs,
    opened,
  };
}

const W = 'Arffornia/Arffornia_Website';
const envOf = (fake, slot) => parseEnv(fake.branches.envs[`envs/${slot}.yaml`].text);

// ------------------------------------------------------------------ up
test('up takes the first free website slot and writes a valid file', async () => {
  const fake = fakeGitHub();
  fake.addPr(W, 115, { head: sha('a') });
  const ctx = ctxFor(fake);
  const res = await run(['up', `${W}#115`], ctx);
  assert.equal(res.slot, 'pr1');
  const env = envOf(fake, 'pr1');
  assert.deepEqual(validateEnv('envs/pr1.yaml', env, NOW), []);
  assert.equal(env.imageTag, `pr-115-${sha('a').slice(0, 7)}`);
  assert.equal(env.expires, '2026-11-04T18:00:00Z');
  assert.deepEqual(ctx.opened, ['https://pr1.arffornia.com/']);
  assert.ok(ctx.logs.join('\n').includes('/faq'), 'prints the #115 checklist');
});

test('three website slots, then a fourth PR is refused', async () => {
  const fake = fakeGitHub();
  for (const n of [101, 102, 103, 104]) fake.addPr(W, n);
  const ctx = ctxFor(fake);
  for (const [n, slot] of [[101, 'pr1'], [102, 'pr2'], [103, 'pr3']]) assert.equal((await run(['up', `${W}#${n}`, '--no-open'], ctx)).slot, slot);
  await assert.rejects(run(['up', `${W}#104`], ctx), /every website slot is taken/);
});

test('up again on the same PR refreshes its slot with the new head', async () => {
  const fake = fakeGitHub();
  fake.addPr(W, 91, { head: sha('1') });
  const ctx = ctxFor(fake);
  await run(['up', `${W}#91`, '--slot', 'pr2'], ctx);
  fake.addPr(W, 91, { head: sha('2') });
  assert.equal((await run(['up', `${W}#91`], ctx)).slot, 'pr2');
  assert.equal(envOf(fake, 'pr2').head, sha('2'));
  assert.equal(fake.branches.envs['envs/pr1.yaml'], undefined);
});

test('an expired slot can be taken; a held one cannot', async () => {
  const fake = fakeGitHub();
  fake.addPr(W, 1); fake.addPr(W, 2);
  await run(['up', `${W}#1`, '--slot', 'pr3', '--ttl', '1h'], ctxFor(fake));
  await assert.rejects(run(['up', `${W}#2`, '--slot', 'pr3'], ctxFor(fake)), /pr3 is held by Arffornia_Website#1/);
  const later = ctxFor(fake, { now: NOW + 2 * 3600e3 });
  assert.equal((await run(['up', `${W}#2`, '--slot', 'pr3'], later)).slot, 'pr3');
});

test('fork PRs are never deployed', async () => {
  const fake = fakeGitHub();
  fake.addPr(W, 5, { fork: true });
  await assert.rejects(run(['up', `${W}#5`], ctxFor(fake)), /fork/);
});

test('red or running CI blocks up, unless --force', async () => {
  const fake = fakeGitHub();
  fake.addPr(W, 6, { head: sha('6') });
  fake.checks[`${W}@${sha('6')}`] = [{ name: 'e2e', status: 'completed', conclusion: 'failure' }, { name: 'build', status: 'in_progress' }];
  await assert.rejects(run(['up', `${W}#6`], ctxFor(fake)), /CI failed .*e2e[\s\S]*CI still running .*build/);
  assert.equal((await run(['up', `${W}#6`, '--force'], ctxFor(fake))).slot, 'pr1');
});

test('missing PR images block up', async () => {
  const fake = fakeGitHub();
  fake.addPr(W, 7);
  await assert.rejects(run(['up', `${W}#7`], ctxFor(fake, { images: false })), /is not published/);
});

test('cluster off: up says so and offers --local; --no-wait still prepares the slot', async () => {
  const fake = fakeGitHub();
  fake.addPr(W, 8);
  await assert.rejects(run(['up', `${W}#8`], ctxFor(fake, { cluster: false })), /cluster looks off[\s\S]*--local/);
  assert.equal(fake.branches.envs['envs/pr1.yaml'], undefined);
  assert.equal((await run(['up', `${W}#8`, '--no-wait'], ctxFor(fake, { cluster: false }))).slot, 'pr1');
});

test('--dry-run writes nothing', async () => {
  const fake = fakeGitHub();
  fake.addPr(W, 9);
  const ctx = ctxFor(fake);
  const res = await run(['up', `${W}#9`, '--dry-run'], ctx);
  assert.equal(res.dryRun, true);
  assert.deepEqual(fake.branches.envs, {});
  assert.ok(fake.calls.every(([m]) => m === 'GET'));
});

test('pack slot: mod PR + Provisioning PR together', async () => {
  const fake = fakeGitHub();
  fake.addPr('Arffornia/Arffornia_Mods', 49, { head: sha('4') });
  fake.addPr('Arffornia/Arffornia_Provisioning', 35, { head: sha('3') });
  const args = ['up', 'Arffornia/Arffornia_Mods#49', 'https://github.com/Arffornia/Arffornia_Provisioning/pull/35'];
  await assert.rejects(run(args, ctxFor(fake)), /no pre-release pr-49/);
  fake.releases['Arffornia/Arffornia_Mods@pr-49'] = { assets: [{ name: 'arffornia.jar' }] };
  const ctx = ctxFor(fake);
  assert.equal((await run(args, ctx)).slot, 'slot');
  const env = envOf(fake, 'slot');
  assert.equal(env.modTag, 'pr-49');
  assert.equal(env.provisioningRef, sha('3'));
  assert.deepEqual(ctx.opened, [], 'the pack slot opens in the beta launcher, not a browser');
  assert.match(ctx.logs.join('\n'), /Test slot[\s\S]*split config/);
});

test('a Provisioning PR alone keeps the edge mod', async () => {
  const fake = fakeGitHub();
  fake.addPr('Arffornia/Arffornia_Provisioning', 42, { head: sha('9') });
  await run(['up', 'Arffornia/Arffornia_Provisioning#42'], ctxFor(fake));
  assert.equal(envOf(fake, 'slot').modTag, 'edge');
});

test('mixed kinds and unknown repos are refused', async () => {
  const fake = fakeGitHub();
  await assert.rejects(run(['up', `${W}#1`, 'Arffornia/Arffornia_Mods#2'], ctxFor(fake)), /different kinds/);
  await assert.rejects(run(['up', 'Arffornia/Nexus_Java#9'], ctxFor(fake)), /no slot serves/);
});

test('launcher PRs point at the beta artifact', async () => {
  const fake = fakeGitHub();
  fake.addPr('Arffornia/Arffornia_Launcher_V.5.2', 59);
  const ctx = ctxFor(fake);
  await run(['up', 'Arffornia/Arffornia_Launcher_V.5.2#59'], ctx);
  assert.match(ctx.logs.join('\n'), /launcher-pr-59[\s\S]*Electron 45/);
  assert.deepEqual(fake.branches.envs, {});
});

test('a slot changed under our feet is a conflict, not an overwrite', () => {
  const fake = fakeGitHub();
  const store = makeStore(makeGh(fake.transport));
  const env = buildEnv({ slot: 'pr1', prs: [{ ...parseRef(`${W}#1`), head: sha('1') }], requestedBy: 'a', now: NOW });
  store.put('pr1', env, null, 'first');
  assert.throws(() => store.put('pr1', env, null, 'second create'), /changed while this command ran/);
  assert.throws(() => store.put('pr1', env, 'stale', 'stale update'), /changed while this command ran/);
});

test('--via-pr opens a PR into envs instead of committing', async () => {
  const fake = fakeGitHub();
  fake.addPr(W, 10);
  const res = await run(['up', `${W}#10`, '--via-pr'], ctxFor(fake));
  assert.equal(res.pr, `https://github.com/${PT}/pull/7`);
  assert.deepEqual(fake.branches.envs, {});
  assert.ok(Object.keys(fake.branches).some((b) => b.startsWith('playtest/pr1-')));
});

// ------------------------------------------------------------------ extend, down, status
test('extend moves expires, capped at 7 days from now', async () => {
  const fake = fakeGitHub();
  fake.addPr(W, 11);
  await run(['up', `${W}#11`], ctxFor(fake));
  await run(['extend', 'pr1', '24h'], ctxFor(fake));
  assert.equal(envOf(fake, 'pr1').expires, '2026-11-05T18:00:00Z');
  await run(['extend', `${W}#11`, '30d'], ctxFor(fake));
  assert.equal(Date.parse(envOf(fake, 'pr1').expires), NOW + MAX_TTL_MS);
});

test('down frees a slot by name or by PR', async () => {
  const fake = fakeGitHub();
  fake.addPr(W, 12); fake.addPr(W, 13);
  await run(['up', `${W}#12`], ctxFor(fake));
  await run(['up', `${W}#13`], ctxFor(fake));
  await run(['down', 'pr1'], ctxFor(fake));
  await run(['down', `${W}#13`], ctxFor(fake));
  assert.deepEqual(fake.branches.envs, {});
  await assert.rejects(run(['down', `${W}#13`], ctxFor(fake)), /no slot holds/);
});

test('status lists every slot with expiry', async () => {
  const fake = fakeGitHub();
  fake.addPr(W, 14);
  await run(['up', `${W}#14`, '--slot', 'pr2'], ctxFor(fake));
  const rows = await run(['status', '--json'], ctxFor(fake, { now: NOW + 3600e3 }));
  assert.deepEqual(rows.map((r) => r.slot), ['pr1', 'pr2', 'pr3', 'slot']);
  assert.equal(rows[1].left, '47 h left');
  assert.equal(rows[0].prs, undefined);
  assert.match(rows[3].prs, /main/);
});

// ------------------------------------------------------------------ reaper
test('the reaper frees expired, closed and invalid slots and keeps the rest', async () => {
  const fake = fakeGitHub();
  fake.addPr(W, 20); fake.addPr(W, 21); fake.addPr(W, 22);
  await run(['up', `${W}#20`, '--ttl', '2h'], ctxFor(fake));
  await run(['up', `${W}#21`], ctxFor(fake));
  await run(['up', `${W}#22`], ctxFor(fake));
  fake.addPr(W, 21, { state: 'closed', merged: true });
  fake.branches.envs['envs/slot.yaml'] = { text: 'slot: "slot"\nkind: "pack"\nmodTag: "edge; rm -rf"\n', sha: 'bad' };
  const gh = makeGh(fake.transport);
  const dry = reap({ gh, store: makeStore(gh), now: NOW + 3 * 3600e3, dryRun: true, log: () => {} });
  assert.equal(dry.freed.length, 3);
  assert.equal(Object.keys(fake.branches.envs).length, 4);
  const res = reap({ gh, store: makeStore(gh), now: NOW + 3 * 3600e3, log: () => {} });
  assert.deepEqual(res.freed.map((v) => v.slot).sort(), ['pr1', 'pr2', 'slot']);
  assert.match(res.freed.find((v) => v.slot === 'pr2').reason, /merged/);
  assert.deepEqual(Object.keys(fake.branches.envs), ['envs/pr3.yaml']);
});

// ------------------------------------------------------------------ format, card
test('env files round-trip and reject values that could inject into a template', () => {
  const env = buildEnv({ slot: 'pr2', prs: [{ ...parseRef(`${W}#115`), head: sha('f') }], requestedBy: 'TheGostsniperfr', now: NOW });
  assert.deepEqual(parseEnv(serializeEnv(env)), env);
  assert.deepEqual(validateEnv('envs/pr2.yaml', env, NOW), []);
  assert.ok(validateEnv('envs/pr2.yaml', { ...env, imageTag: 'x"\n  evil: true' }, NOW).some((e) => /unsafe/.test(e)));
  assert.ok(validateEnv('envs/pr1.yaml', env, NOW).some((e) => /slot is "pr2"/.test(e)));
  assert.ok(validateEnv('envs/slot.yaml', env, NOW).some((e) => /kind must be "pack"/.test(e)));
  assert.ok(validateEnv('envs/prod.yaml', env, NOW)[0].includes('not a slot file'));
  assert.ok(validateEnv('envs/pr2.yaml', { ...env, prs: ['Arffornia/Arffornia_Mods#1'] }, NOW).some((e) => /no website slot/.test(e)));
  assert.ok(validateEnv('envs/pr2.yaml', extendEnv(env, 30 * 86400e3, NOW + 30 * 86400e3), NOW).some((e) => /7 days/.test(e)));
});

test('the card has one OK/KO row per checklist PR, sessions A to D', () => {
  const card = buildCard({ held: { pr1: { prs: [`${W}#115`], prsText: 'Arffornia_Website#115', expires: '2026-11-04T18:00:00Z' } } });
  const rows = loadSessions().flatMap((s) => s.rows);
  assert.equal(card.decisions.length, rows.length);
  assert.equal(rows.length, 16);
  assert.equal(card.title, 'Playtest: sessions A, B, C, D');
  const r101 = card.decisions.find((d) => d.id === 'pt-arffornia-arffornia_website-101');
  assert.match(r101.why, /Open: https:\/\/pr1\.arffornia\.com\//);
  assert.ok(card.links.every((l) => l.url.startsWith('https://')));
  assert.equal(buildCard({ only: ['D'] }).decisions.length, 3);
});
