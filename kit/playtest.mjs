#!/usr/bin/env node
// Arffornia PR playtest kit: one command to test a pull request in game, with a generated guide.
//
//   playtest guide  <owner/repo#n>              write the test guide (what changed, what to test, what to watch, decisions)
//   playtest up     <owner/repo#n> [--light|--full] [--local|--slot] [--dry-run]
//                                               start server + game for that PR (local by default)
//   playtest down                               stop the running environment (only one runs at a time)
//   playtest report <owner/repo#n> [--verdict ok|ko] [--notes "..."] [--decision D1=a ...] [--post]
//                                               turn your findings into a review-stack answer (+ PR comment)
//
// No dependencies: Node 20+, the GitHub CLI (`gh`, REST only), git, Java 21 for local envs.
// Resource rule (Brian, 2026-10-31): one full-pack environment at a time (~50 GB RAM); light
// single-mod environments are cheap. The lock file enforces "one at a time".
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = process.env.ARF_PLAYTEST_HOME || path.join(os.homedir(), '.arffornia-playtest');
const LOCK = path.join(HOME, 'env.lock.json');
const WT = process.env.ARF_WORKTREES || '/root/arffornia/wt';
const MARK_AGENT = '<!-- arffornia-playtest-agent -->';
const MARK_GUIDE = '<!-- arffornia-playtest-guide -->';
const MARK_REPORT = '<!-- arffornia-playtest-report -->';

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const gh = (p) => JSON.parse(sh('gh', ['api', p]));
const ghAll = (p) => JSON.parse(sh('gh', ['api', '--paginate', '--slurp', p])).flat();
const die = (m) => { console.error(`playtest: ${m}`); process.exit(1); };

function parseRef(ref) {
  const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(ref || '') || /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(ref || '');
  if (!m) die(`expected owner/repo#number or a PR URL, got "${ref}"`);
  return { owner: m[1], repo: m[2], n: Number(m[3]), slug: `${m[1]}/${m[2]}` };
}

// ------------------------------------------------------------------ PR facts
function loadPR(r) {
  const pr = gh(`repos/${r.slug}/pulls/${r.n}`);
  const files = ghAll(`repos/${r.slug}/pulls/${r.n}/files?per_page=100`);
  const comments = ghAll(`repos/${r.slug}/issues/${r.n}/comments?per_page=100`);
  let checks = [];
  try { checks = gh(`repos/${r.slug}/commits/${pr.head.sha}/check-runs?per_page=100`).check_runs; } catch { /* no checks */ }
  return { pr, files, comments, checks };
}

// Markdown sections of the PR body, by heading text (lowercase).
function sections(body = '') {
  const out = {}; let cur = '_';
  for (const line of body.split('\n')) {
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    if (h) { cur = h[1].trim().toLowerCase(); out[cur] = []; continue; }
    (out[cur] ||= []).push(line);
  }
  return out;
}
const pick = (secs, ...keys) => Object.entries(secs).filter(([k]) => keys.some((x) => k.includes(x))).flatMap(([, v]) => v).join('\n').trim();

// What a changed path means for a human tester (Arffornia repos). First match wins per file.
const AREAS = [
  [/\/gametest\/|src\/test\/|\.test\.|__tests__|\/tests?\//, 'tests', 'Automated tests only: nothing to see in game for these files.'],
  [/network|packet|payload/i, 'network', 'Client/server sync: test with the server and a client, watch for desync (values that differ between what you see and what happens), and reconnect once.'],
  [/(blockentity|block_entity|machine|multiblock)/i, 'machines', 'Machines: place one, power it, feed it, break it and place it again; check it survives a chunk unload (fly away 200 blocks and back) and a server restart.'],
  [/\/lang\/|i18n|translat/i, 'translations', 'Text: switch the game language between English and French; look for raw keys (like arffornia.foo.bar) or truncated text.'],
  [/\/recipes?\/|recipe/i, 'recipes', 'Recipes: look them up in JEI/EMI, craft each one once.'],
  [/worldgen|biome|feature|structure/i, 'worldgen', 'World generation: needs a NEW world; changes only apply to new chunks.'],
  [/\/(gui|screen|client)\//i, 'ui', 'Screens: open them at GUI scale 2 and 4 and at a small window size; check keyboard navigation and hover texts.'],
  [/config/i, 'config', 'Config: check the defaults on a fresh instance, and which side (server or client) a value lives on.'],
  [/\/(models?|textures?|blockstates)\//i, 'assets', 'Models and textures: look at the block from all sides, in the inventory, in hand, at night.'],
  [/(api|http|web|client\/api)/i, 'api', 'Website API: the website must be reachable; check behaviour when it is down (no crash, clear message).'],
  [/\.github\/|gradle|build\.gradle|package(-lock)?\.json|\.nix/i, 'build', 'Build and CI only: no in-game test needed unless the game fails to start.'],
];
function classify(files) {
  const by = new Map();
  for (const f of files) {
    const a = AREAS.find(([re]) => re.test(f.filename)) || [null, 'other', 'Other changes: skim the diff for anything visible in game.'];
    if (!by.has(a[1])) by.set(a[1], { area: a[1], tip: a[2], files: [] });
    by.get(a[1]).files.push(`${f.filename} (+${f.additions}/-${f.deletions})`);
  }
  return [...by.values()];
}

// Environment sizing (Brian's rule): the mod repo alone is light; the pack is full.
function envFor(r, pr) {
  const labels = pr.labels.map((l) => l.name);
  if (labels.includes('needs-full-pack') || /Provisioning|minecraft-server-charts|infra/i.test(r.repo)) return 'full';
  if (/Arffornia_Mods|Nexus_Mods/i.test(r.repo)) return 'light';
  if (/Launcher|Nexus_/i.test(r.repo)) return 'launcher';
  if (/Website|keycloak/i.test(r.repo)) return 'web';
  return 'none';
}

function guide(r, data) {
  const { pr, files, comments, checks } = data;
  const secs = sections(pr.body || '');
  const env = envFor(r, pr);
  const areas = classify(files).filter((a) => a.area !== 'tests');
  const howTo = pick(secs, 'how to test', 'test plan', 'testing', 'to test');
  const decisions = [...new Set([pick(secs, 'decision'), ...((pr.body || '').split('\n').filter((l) => /needs[- ]decision|\bD\d+\b.*:/i.test(l)))].join('\n').split('\n').map((s) => s.trim()).filter(Boolean))];
  const agent = comments.filter((c) => c.body.includes(MARK_AGENT)).pop();
  const failing = checks.filter((c) => c.conclusion && !['success', 'skipped', 'neutral'].includes(c.conclusion));
  const pending = checks.filter((c) => c.status !== 'completed');
  const risk = areas.some((a) => ['network', 'machines', 'worldgen'].includes(a.area)) ? 'high' : areas.some((a) => ['ui', 'recipes', 'config', 'api'].includes(a.area)) ? 'medium' : 'low';
  const start = { light: `playtest up ${r.slug}#${r.n}            # light env: this mod + its dependencies, local, ~4 GB RAM`,
    full: `playtest up ${r.slug}#${r.n} --full     # full pack (330 mods): local or the cluster preview slot, ~12-16 GB per server, one at a time`,
    launcher: `playtest up ${r.slug}#${r.n}            # builds and opens this launcher branch`,
    web: `playtest up ${r.slug}#${r.n}            # website preview (if the repo has one), otherwise the PR's own instructions`,
    none: `(nothing to start: review the diff)` }[env];
  const L = [];
  L.push(MARK_GUIDE, `# Playtest guide: ${pr.title}`, '');
  L.push(`[${r.slug}#${r.n}](${pr.html_url}) at \`${pr.head.sha.slice(0, 7)}\`, environment **${env}**, risk **${risk}**.`, '');
  L.push('## Start', '', '```sh', start, '```', '');
  if (failing.length || pending.length) L.push(`> CI: ${failing.length} failing, ${pending.length} still running (${[...failing, ...pending].map((c) => c.name).join(', ')}). Testing now may waste your time.`, '');
  L.push('## What changed', '');
  const summary = pick(secs, 'summary', 'what', 'why', '_').split('\n').filter((l) => l.trim() && !l.startsWith('<!--') && !l.startsWith('>')).slice(0, 6).map((l) => (l.length > 260 ? `${l.slice(0, 257)}...` : l));
  if (summary.length) L.push(...summary, '');
  for (const a of areas) L.push(`- **${a.area}**: ${a.files.length} file(s), e.g. ${a.files.slice(0, 3).map((f) => `\`${f}\``).join(', ')}`);
  L.push('', '## What the agents already checked', '');
  if (agent) L.push(agent.body.replace(MARK_AGENT, '').trim(), '');
  else L.push('No in-game agent report on this PR yet. The agent playtest runs before this guide when the PR has the `playtest` label.', '');
  L.push('## What to test', '');
  if (howTo) L.push(howTo, '');
  for (const a of areas.filter((x) => x.area !== 'build')) L.push(`- [ ] ${a.tip}`);
  L.push('- [ ] The game starts, you can join, and nothing in the log says ERROR from `arffornia`.', '');
  L.push('## What to watch', '');
  L.push('- Frame rate and TPS while the feature runs (F3; `/neoforge tps`).');
  if (areas.some((a) => a.area === 'network')) L.push('- Desync: what the client shows versus what the server does (reconnect once).');
  if (areas.some((a) => a.area === 'machines')) L.push('- A machine across a chunk border, and after a restart.');
  L.push('- Anything that looks unfinished: missing texture (pink/black), raw translation keys, English text in French.', '');
  L.push('## Decisions to report', '');
  if (decisions.length) L.push(...decisions.map((d) => (d.startsWith('-') ? d : `- ${d}`)), '');
  else L.push('- None listed in the PR. If something felt wrong or you would do it differently, say it in the notes.', '');
  L.push('## Report back', '', '```sh', `playtest report ${r.slug}#${r.n} --verdict ok --notes "..." --post     # or --verdict ko`, '```',
    'This posts your verdict on the PR and writes it in the review-stack answer format, so the agents pick it up.', '');
  return L.join('\n');
}

// ------------------------------------------------------------------ environments
const readLock = () => { try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return null; } };
function plan(r, pr, kind, where) {
  const wt = path.join(WT, `playtest-${r.repo}-${r.n}`);
  const steps = [];
  steps.push(['git', ['-C', `/root/arffornia/${r.repo}`, 'fetch', 'origin', `pull/${r.n}/head:playtest/${r.n}`]]);
  steps.push(['git', ['-C', `/root/arffornia/${r.repo}`, 'worktree', 'add', '--force', wt, `playtest/${r.n}`]]);
  if (kind === 'light') {
    // NeoForge dev run: a dedicated server and a client that joins it (Quick Play, 1.20+).
    steps.push(['sh', ['-c', `cd ${wt} && ./gradlew --offline runServer --args=nogui`], { background: 'server', wait: /Done \(/ }]);
    steps.push(['sh', ['-c', `cd ${wt} && ./gradlew --offline runClient --args="--quickPlayMultiplayer localhost:25565 --username Brian"`], { background: 'client' }]);
  } else if (kind === 'full' && where === 'local') {
    // The pack from Provisioning at this PR, plus the server image used in production.
    steps.push(['sh', ['-c', `docker run -d --name arf-playtest -p 25565:25565 -e EULA=TRUE -e TYPE=NEOFORGE -e VERSION=1.21.1 -e NEOFORGE_VERSION=21.1.172 -e MEMORY=12G -v ${wt}/dist:/data ghcr.io/itzg/minecraft-server:java21`]]);
    steps.push(['echo', ['Launch the Arffornia launcher with the preview profile (launcher feature: "Preview a PR"), or a vanilla NeoForge 21.1.172 instance with the pack.']]);
  } else if (kind === 'full' && where === 'slot') {
    // The single cluster preview slot (ADR-0007, revised: one slot, leased): deploy this PR's bundle there.
    steps.push(['gh', ['workflow', 'run', 'preview-slot.yml', '-R', 'TheGostsniperfr/infra', '-f', `pr=${r.slug}#${r.n}`, '-f', `sha=${pr.head.sha}`]]);
    steps.push(['echo', [`Join preview.arffornia.example (mc-router hostname) once the workflow reports "ready".`]]);
  } else steps.push(['echo', [`No game environment for this repo; open ${pr.html_url}`]]);
  return { wt, steps };
}

async function up(r, opts) {
  const lock = readLock();
  const { pr } = { pr: gh(`repos/${r.slug}/pulls/${r.n}`) };
  const kind = opts.full ? 'full' : opts.light ? 'light' : envFor(r, pr);
  const where = opts.slot ? 'slot' : 'local';
  if (lock && !opts['dry-run']) die(`an environment is already running (${lock.pr}, ${lock.kind}). Run "playtest down" first: one environment at a time.`);
  const p = plan(r, pr, kind, where);
  const guideText = guide(r, loadPR(r));
  fs.mkdirSync(HOME, { recursive: true });
  const gpath = path.join(HOME, `guide-${r.repo}-${r.n}.md`); fs.writeFileSync(gpath, guideText);
  console.log(`environment: ${kind} (${where}); guide: ${gpath}`);
  for (const [cmd, args, o] of p.steps) console.log(`  $ ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}${o?.background ? '   &' : ''}`);
  if (opts['dry-run']) return;
  const pids = [];
  for (const [cmd, args, o] of p.steps) {
    if (!o?.background) { execFileSync(cmd, args, { stdio: 'inherit' }); continue; }
    const log = path.join(HOME, `${o.background}.log`); const out = fs.openSync(log, 'w');
    const c = spawn(cmd, args, { detached: true, stdio: ['ignore', out, out] }); c.unref(); pids.push(c.pid);
    if (o.wait) { process.stdout.write(`waiting for ${o.background}`); while (!o.wait.test(fs.readFileSync(log, 'utf8'))) { await new Promise((s) => setTimeout(s, 2000)); process.stdout.write('.'); } console.log(' ready'); }
  }
  fs.writeFileSync(LOCK, JSON.stringify({ pr: `${r.slug}#${r.n}`, kind, where, wt: p.wt, pids, at: new Date().toISOString() }, null, 1));
  console.log(`up. Follow the guide: ${gpath}`);
}

function down() {
  const lock = readLock(); if (!lock) return console.log('nothing running');
  for (const pid of lock.pids || []) { try { process.kill(-pid); } catch { try { process.kill(pid); } catch { /* gone */ } } }
  if (lock.kind === 'full' && lock.where === 'local') { try { sh('docker', ['rm', '-f', 'arf-playtest']); } catch { /* not running */ } }
  fs.rmSync(LOCK); console.log(`stopped ${lock.pr}. The worktree stays at ${lock.wt} (git worktree remove it when done).`);
}

function report(r, opts) {
  const verdict = opts.verdict || 'ok';
  const decisions = Object.fromEntries([].concat(opts.decision || []).map((d) => d.split('=')).map(([k, v]) => [k, { choice: v }]));
  const answer = { at: new Date().toISOString(), source: 'playtest', pr: `${r.slug}#${r.n}`, verdict: verdict === 'ok' ? 'approve' : 'changes', decisions, notes: opts.notes || '' };
  fs.mkdirSync(HOME, { recursive: true });
  const f = path.join(HOME, `answer-${r.repo}-${r.n}.json`); fs.writeFileSync(f, JSON.stringify(answer, null, 2));
  const body = [MARK_REPORT, `**Playtest by the maintainer: ${verdict === 'ok' ? 'works' : 'does not work yet'}**`, '', answer.notes || '_no notes_', '',
    Object.keys(decisions).length ? `Decisions: ${Object.entries(decisions).map(([k, v]) => `${k} = ${v.choice}`).join(', ')}` : '', '',
    '<details><summary>review-stack answer</summary>', '', '```json', JSON.stringify(answer, null, 2), '```', '</details>'].join('\n');
  if (opts.post) { sh('gh', ['api', `repos/${r.slug}/issues/${r.n}/comments`, '-f', `body=${body}`]); console.log(`posted on ${r.slug}#${r.n}`); }
  else console.log(body);
  console.log(`answer: ${f}`);
}

// ------------------------------------------------------------------ cli
const [cmd, ref, ...rest] = process.argv.slice(2);
const opts = {}; for (let i = 0; i < rest.length; i++) { const m = /^--([\w-]+)$/.exec(rest[i]); if (!m) continue; const nx = rest[i + 1]; if (nx && !nx.startsWith('--')) { opts[m[1]] = opts[m[1]] ? [].concat(opts[m[1]], nx) : nx; i++; } else opts[m[1]] = true; }
if (cmd === 'guide') { const r = parseRef(ref); const g = guide(r, loadPR(r)); if (opts.out) fs.writeFileSync(opts.out, g); else console.log(g); }
else if (cmd === 'up') await up(parseRef(ref), opts);
else if (cmd === 'down') down();
else if (cmd === 'report') report(parseRef(ref), opts);
else { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(cmd ? 1 : 0); }
