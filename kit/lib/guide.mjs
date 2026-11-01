// The test guide for a PR: what changed, what to test, what to watch, decisions to report.
import { execFileSync } from 'node:child_process';

export const MARK_AGENT = '<!-- arffornia-playtest-agent -->';
export const MARK_GUIDE = '<!-- arffornia-playtest-guide -->';
export const MARK_REPORT = '<!-- arffornia-playtest-report -->';

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
const gh = (p) => JSON.parse(sh('gh', ['api', p]));
const ghAll = (p) => JSON.parse(sh('gh', ['api', '--paginate', '--slurp', p])).flat();

export function loadPR(r) {
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
export function envFor(r, pr) {
  const labels = pr.labels.map((l) => l.name);
  if (labels.includes('needs-full-pack') || /Provisioning|minecraft-server-charts|infra/i.test(r.repo)) return 'full';
  if (/Arffornia_Mods|Nexus_Mods/i.test(r.repo)) return 'light';
  if (/Launcher|Nexus_/i.test(r.repo)) return 'launcher';
  if (/Website|keycloak/i.test(r.repo)) return 'web';
  return 'none';
}

export function guide(r, data) {
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
  const start = { light: `playtest up ${r.slug}#${r.n}            # the test slot (test.arffornia.com:25566); --local --light for this mod alone on your machine`,
    full: `playtest up ${r.slug}#${r.n}            # the test slot (full pack, one at a time); --local --full on your machine`,
    launcher: `playtest up ${r.slug}#${r.n}            # where to download the beta artifact launcher-pr-${r.n}`,
    web: `playtest up ${r.slug}#${r.n}            # a website slot, pr1-pr3.arffornia.com`,
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
