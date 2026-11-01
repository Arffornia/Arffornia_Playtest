// The 10-minute checklists (checklists/sessions.json) and the review-stack Playtest card.
//
// Card shape: the review stack's `chantiers` documents (order, status, title, summary, detail,
// links, decisions). One decision per PR row, OK or KO; Brian's OK approves the PR (D9).
import fs from 'node:fs';
import { SLOTS } from './slots.mjs';

const DATA = new URL('../../checklists/sessions.json', import.meta.url);
export const loadSessions = () => JSON.parse(fs.readFileSync(DATA, 'utf8')).sessions;

const prUrl = (ref) => {
  const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(ref);
  return m ? `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` : null;
};
const short = (ref) => ref.replace(/^[\w.-]+\//, '');

// Every checklist row for a PR (a PR can appear once; `with` PRs share a row).
export function rowsFor(ref, sessions = loadSessions()) {
  const out = [];
  for (const s of sessions) for (const r of s.rows) if (r.pr === ref || (r.with || []).includes(ref)) out.push({ session: s, row: r });
  return out;
}

export function checklistText(refs, sessions = loadSessions()) {
  const seen = new Set();
  const L = [];
  for (const ref of refs) {
    for (const { session, row } of rowsFor(ref, sessions)) {
      if (seen.has(row.pr)) continue;
      seen.add(row.pr);
      L.push(`  [ ] ${short(row.pr)} ${row.title} (session ${session.id}): ${row.check}`);
    }
  }
  if (!L.length) L.push('  [ ] No checklist row for these PRs in checklists/sessions.json: follow "playtest guide <pr>".');
  return L.join('\n');
}

// Where Brian opens a row: a slot URL, the test server, or the beta artifact.
function openFor(session, row, held) {
  if (/Launcher/i.test(row.pr)) return session.id === 'A' ? 'Beta artifact launcher-candidate' : `Beta artifact launcher-pr-${row.pr.split('#')[1]}`;
  if (/infra#/.test(row.pr)) return 'https://staging.arffornia.com/';
  // A row is served by the slot that holds it, its `up` PRs, or its session's stack tip.
  const wanted = [row.pr, ...(row.up || []), ...(session.up || [])];
  const slot = Object.keys(held).find((s) => held[s] && [].concat(held[s].prs).some((p) => wanted.includes(p)));
  if (slot) return SLOTS[slot].kind === 'pack' ? `Beta launcher, Test slot (${SLOTS[slot].server})` : SLOTS[slot].url;
  return 'not deployed yet: an agent runs playtest up first';
}

// `held`: slot -> env (from the store), so rows can link to live environments.
export function buildCard({ sessions = loadSessions(), only = null, held = {}, titles = {}, order = 30 } = {}) {
  const picked = sessions.filter((s) => !only || only.includes(s.id));
  const decisions = [];
  const links = [];
  for (const s of picked) {
    for (const row of s.rows) {
      const open = openFor(s, row, held);
      decisions.push({
        id: `pt-${row.pr.replace(/[^\w]+/g, '-').toLowerCase()}`,
        q: `Session ${s.id} · ${short(row.pr)}${titles[row.pr] ? ` ${titles[row.pr]}` : ` (${row.title})`}: does it work?`,
        why: `${row.check} Open: ${open}.`,
        options: ['OK', 'KO (say what in the notes)'],
      });
      const u = prUrl(row.pr);
      if (u) links.push({ url: u, label: short(row.pr), note: `session ${s.id}: ${row.title}` });
    }
  }
  for (const [slot, env] of Object.entries(held)) {
    if (!env || SLOTS[slot].kind !== 'website') continue;
    links.push({ url: SLOTS[slot].url, label: `${slot}.arffornia.com`, note: `${env.prsText}, until ${env.expires}` });
  }
  return {
    order,
    status: 'ready',
    title: `Playtest: session${picked.length > 1 ? 's' : ''} ${picked.map((s) => s.id).join(', ')}`,
    summary: `${decisions.length} PRs, about 10 minutes each (less in batches). Follow each row's checklist and answer OK or KO. Your OK approves the PR; an agent then removes needs-playtest and merges it in stack order.`,
    detail: picked.map((s) => `Session ${s.id}, ${s.title}: ${s.where}.`).join(' '),
    links,
    decisions,
  };
}
