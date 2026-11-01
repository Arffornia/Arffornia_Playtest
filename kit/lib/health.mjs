// Network probes: is the cluster up, does a slot answer, are a PR's images published.
// Every probe has a timeout and never throws: it answers { ok, detail }.
import { SLOTS, STAGING_URL } from './slots.mjs';

async function get(url, { timeoutMs = 8000, method = 'GET', headers = {} } = {}) {
  try {
    const res = await fetch(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, text: method === 'HEAD' ? '' : await res.text().catch(() => '') };
  } catch (e) {
    return { status: 0, text: String(e.cause?.code || e.name || e.message) };
  }
}

export async function clusterUp() {
  const r = await get(STAGING_URL, { timeoutMs: 6000 });
  return { ok: r.status > 0 && r.status < 500, detail: r.status ? `staging answered ${r.status}` : `staging unreachable (${r.text})` };
}

// A website slot is up when `/` answers 2xx or 3xx.
export async function websiteUp(slot) {
  const r = await get(SLOTS[slot].url);
  return { ok: r.status >= 200 && r.status < 400, detail: r.status ? `HTTP ${r.status}` : r.text };
}

// The pack slot is up when pack-files serves the requested ref and the server answers a ping.
export async function packUp(env) {
  const pf = await get(SLOTS.slot.url);
  let served = null;
  try { served = JSON.parse(pf.text); } catch { /* not up yet */ }
  if (!served) return { ok: false, detail: pf.status ? `pack-files HTTP ${pf.status}` : 'pack-files unreachable' };
  if (env && (served.provisioningRef !== env.provisioningRef || served.modTag !== env.modTag)) {
    return { ok: false, detail: `pack-files still serves ${served.provisioningRef} / ${served.modTag}` };
  }
  const st = await get(`https://api.mcstatus.io/v2/status/java/${SLOTS.slot.server}`, { timeoutMs: 15000 });
  let j = null;
  try { j = JSON.parse(st.text); } catch { /* no answer */ }
  if (!j) return { ok: false, detail: 'mcstatus.io did not answer' };
  return j.online ? { ok: true, detail: `online, ${j.version?.name_clean || 'unknown version'}` } : { ok: false, detail: 'server offline (booting a full pack takes up to 15 min)' };
}

export const slotUp = (slot, env) => (SLOTS[slot].kind === 'website' ? websiteUp(slot) : packUp(env));

// Does ghcr.io/<image>:<tag> exist? Anonymous pull token: the Arffornia packages are public.
export async function imageExists(image, tag) {
  const tok = await get(`https://ghcr.io/token?scope=repository:${image}:pull`);
  let token = null;
  try { token = JSON.parse(tok.text).token; } catch { /* below */ }
  if (!token) return { ok: null, detail: `could not reach ghcr.io (${tok.text || tok.status})` };
  const r = await get(`https://ghcr.io/v2/${image}/manifests/${tag}`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json' },
  });
  if (r.status === 200) return { ok: true, detail: `${image}:${tag}` };
  if (r.status === 404) return { ok: false, detail: `${image}:${tag} is not published` };
  return { ok: null, detail: `ghcr.io answered ${r.status || r.text}` };
}

export async function waitFor(probe, { timeoutMs, everyMs = 10000, onTick = () => {} }) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await probe();
    onTick(r);
    if (r.ok) return r;
    if (Date.now() + everyMs > end) return r;
    await new Promise((s) => setTimeout(s, everyMs));
  }
}
