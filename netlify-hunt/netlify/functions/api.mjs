// QR Treasure Hunt API — Netlify Function (v2) + Netlify Blobs storage.
// Every piece of mutable state lives under its own key, so simultaneous scans by different teams never overwrite each other.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// Create the store per call: the Blobs access token is tied to the current invocation and goes stale if cached at module level.
const S_ = () => getStore({ name: "hunt", consistency: "strong" });
const now = () => Date.now();
const pad = n => String(n).padStart(15, "0");
const rid = () => crypto.randomBytes(3).toString("hex");
const clean = (s, n = 400) => String(s ?? "").trim().slice(0, n);
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const json = (b, status = 200, headers = {}) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

// ---------- storage helpers ----------
const get = k => S_().get(k, { type: "json" });
const put = (k, v) => S_().setJSON(k, v);
const keys = async prefix => (await S_().list({ prefix })).blobs.map(b => b.key).sort();
const delPrefix = async prefix => { await Promise.all((await keys(prefix)).map(k => S_().delete(k))); };
const defaultCfg = () => ({
  settings: { active: true, sabotageMinutes: 10, cooldownMinutes: 3, eventName: "Hasmukh Karkhana", finale: "You cracked the final clue! Run to the organisers and claim your treasure." },
  nextId: 1, teams: [], stations: [],
});
const getCfg = async () => (await get("config")) || defaultCfg();
const saveCfg = c => put("config", c);
const newId = c => c.nextId++;
const newCode = () => crypto.randomBytes(5).toString("base64url").replace(/[-_]/g, "x").toLowerCase();

// ---------- auth (stateless signed cookie) ----------
const secret = () => process.env.SESSION_SECRET || "hunt|" + process.env.ADMIN_PASSWORD;
const hmac = b => crypto.createHmac("sha256", secret()).update(b).digest("base64url");
const sign = p => { const b = Buffer.from(JSON.stringify(p)).toString("base64url"); return b + "." + hmac(b); };
function verify(t) {
  if (!t) return null; const [b, s] = t.split("."); if (!b || !s || !safeEq(s, hmac(b))) return null;
  try { const p = JSON.parse(Buffer.from(b, "base64url").toString()); return p.exp > now() ? p : null; } catch { return null; }
}
const cookieOf = (req, n) => (req.headers.get("cookie") || "").split(";").map(s => s.trim().split("=")).find(p => p[0] === n)?.[1];
const setCookie = p => ({ "set-cookie": `sid=${sign({ ...p, exp: now() + 3 * 864e5 })}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${3 * 86400}` });
const pwv = pw => crypto.createHash("sha256").update("pv" + pw).digest("hex").slice(0, 10);
const session = req => verify(cookieOf(req, "sid"));
const isAdmin = req => !!session(req)?.a;
const teamFrom = (req, cfg) => { const s = session(req); const t = s?.t && cfg.teams.find(x => x.id === s.t); return t && s.pv === pwv(t.password) ? t : null; };
const body = async req => { try { return await req.json(); } catch { return {}; } };

// ---------- game helpers ----------
const getProg = async id => (await get(`prog/${id}`)) || { progress: 0, lastAt: 0, finishedAt: null };
const stationOf = (cfg, id) => cfg.stations.find(s => s.id === id);
// Clue logic: a station owns the riddle that LEADS TO it. A team's clue after step i = custom override, else riddle of step i+1, else the finale.
const hintFor = (cfg, stationId) => { const st = stationOf(cfg, stationId); return st ? (st.riddle || `Find “${st.name}”.`) : ""; };
const clueAt = (cfg, t, i) => { const r = t.route[i]; if (!r) return ""; if (r.clue) return r.clue; const nx = t.route[i + 1]; return nx ? hintFor(cfg, nx.station_id) : cfg.settings.finale; };
const startClueOf = (cfg, t) => t.start_clue || (t.route[0] ? hintFor(cfg, t.route[0].station_id) : "");
const lockOf = async (victimId, stationId) => { const l = await get(`lock/${victimId}/${stationId}`); return l && l.until > now() ? l : null; };

async function leaderboard(cfg, withStats = false) {
  const rows = await Promise.all(cfg.teams.map(async t => {
    const pr = await getProg(t.id), total = t.route.length, progress = Math.min(pr.progress, total);
    const st = withStats ? (await get(`stat/${t.id}`)) || {} : {};
    return { id: t.id, name: t.name, progress, total, finishedAt: total > 0 && progress >= total ? pr.finishedAt || pr.lastAt : null, at: pr.lastAt,
      assistsGiven: st.assists || 0, sabotagesGiven: st.sabotages || 0 };
  }));
  return rows.sort((a, b) => (b.finishedAt ? 1 : 0) - (a.finishedAt ? 1 : 0) || b.progress - a.progress || (a.at || 9e15) - (b.at || 9e15));
}
async function addLog(entry) { await put(`log/${pad(now())}-${rid()}`, { at: now(), ...entry }); }
async function addEvent(teamId, type, message, stationId) { await put(`ev/${teamId}/${pad(now())}-${rid()}`, { type, message, at: now(), stationId }); }
async function bump(teamId, field) { const s = (await get(`stat/${teamId}`)) || {}; s[field] = (s[field] || 0) + 1; await put(`stat/${teamId}`, s); }

async function targetsFor(cfg, station, me) {
  const out = [];
  for (const t of cfg.teams) {
    if (t.id === me.id) continue;
    const idx = t.route.findIndex(r => r.station_id === station.id);
    if (idx < 0) continue;
    const pr = await getProg(t.id);
    if (idx < Math.min(pr.progress, t.route.length)) continue;
    const [lock, assist] = await Promise.all([lockOf(t.id, station.id), get(`assist/${me.id}/${t.id}/${station.id}`)]);
    out.push({ id: t.id, name: t.name, locked: !!lock, assisted: !!assist });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- handler ----------
export default async (req) => {
  if (!process.env.ADMIN_PASSWORD) return json({ error: "Server not configured: add an ADMIN_PASSWORD environment variable in Netlify, then redeploy." }, 500);
  const url = new URL(req.url), p = url.pathname.replace(/^\/api/, ""), m = req.method;
  try {
    if (p.startsWith("/admin")) return await admin(req, p, m, url);
    const cfg = await getCfg(), S = cfg.settings;

    if (p === "/public") return json({ eventName: S.eventName });
    if (p === "/login" && m === "POST") {
      const b = await body(req);
      const t = cfg.teams.find(x => x.name.toLowerCase() === clean(b.team, 60).toLowerCase());
      if (!t || !safeEq(String(b.password || ""), t.password)) return json({ error: "Wrong team name or password." }, 401);
      return json({ ok: true }, 200, setCookie({ t: t.id, pv: pwv(t.password) }));
    }
    if (p === "/logout" && m === "POST") return json({ ok: true }, 200, { "set-cookie": "sid=; Path=/; Max-Age=0" });

    const me = teamFrom(req, cfg);
    if (!me) return json({ error: "login" }, 401);

    if (p === "/me") {
      const pr = await getProg(me.id), total = me.route.length, progress = Math.min(pr.progress, total);
      const revealed = me.route.slice(0, progress).map((r, idx) => ({ idx, clue: clueAt(cfg, me, idx), station: stationOf(cfg, r.station_id)?.name || "" }));
      const myStat = (await get(`stat/${me.id}`)) || {}, hits = (await keys(`hit/${me.id}/`)).length;
      const seenTs = (await get(`seen/${me.id}`)) || 0;
      const evKeys = (await keys(`ev/${me.id}/`)).slice(-30).reverse();
      const events = (await Promise.all(evKeys.map(async k => ({ id: k, ...(await get(k)) }))))
        .filter(e => e.at).map(e => ({ id: e.id, type: e.type, message: e.message, created_at: e.at, seen: e.at <= seenTs }));
      return json({ eventName: S.eventName, active: S.active, team: { id: me.id, name: me.name }, progress, total,
        finished: total > 0 && progress >= total, startClue: startClueOf(cfg, me), stats: { assists: myStat.assists || 0, sabotages: myStat.sabotages || 0, hits }, revealed, events, unseen: events.filter(e => !e.seen).length,
        leaderboard: await leaderboard(cfg), now: now() });
    }
    if (p === "/events/seen" && m === "POST") { await put(`seen/${me.id}`, now()); return json({ ok: true }); }

    let mm;
    if ((mm = p.match(/^\/scan\/([a-z0-9]+)$/)) && m === "GET") {
      if (!S.active) return json({ status: "inactive" });
      const st = cfg.stations.find(s => s.code === mm[1]);
      if (!st) return json({ status: "unknown" });
      const pr = await getProg(me.id), route = me.route, total = route.length, p0 = Math.min(pr.progress, total);
      const lock = await lockOf(me.id, st.id), base = { station: st.name };
      const cur = route[p0], doneIdx = route.findIndex((r, i) => i < p0 && r.station_id === st.id), ahead = route.findIndex((r, i) => i > p0 && r.station_id === st.id);

      if (cur && cur.station_id === st.id) {
        if (lock) return json({ ...base, status: "locked", until: lock.until, now: now() });
        const finished = p0 + 1 >= total, t = now();
        await put(`prog/${me.id}`, { progress: p0 + 1, lastAt: t, finishedAt: finished ? t : null });
        await addLog({ type: finished ? "finish" : "advance", from: me.id, fromName: me.name, stationName: st.name, step: p0 + 1, total });
        return json({ ...base, status: finished ? "finished" : "advance", clue: clueAt(cfg, me, p0), step: p0 + 1, total });
      }
      if (doneIdx >= 0) {
        if (lock) return json({ ...base, status: "locked", until: lock.until, now: now() });
        return json({ ...base, status: "replay", clue: clueAt(cfg, me, doneIdx), step: doneIdx + 1, total });
      }
      if (ahead >= 0) {
        // Shared slot: another team has this very QR at the very same step number -> nobody is early or an intruder. No drama, no Assist/Sabotage.
        const mates = cfg.teams.filter(t => t.id !== me.id && t.route[ahead]?.station_id === st.id).map(t => t.name);
        if (mates.length) return json({ ...base, status: "shared", step: ahead + 1, total, mates, clue: p0 === 0 ? startClueOf(cfg, me) : clueAt(cfg, me, p0 - 1) });
      }
      const targets = await targetsFor(cfg, st, me);
      const cool = (await get(`cool/${me.id}`)) || 0;
      return json({ ...base, status: ahead >= 0 ? "notyet" : "foreign", targets, sabotageMinutes: S.sabotageMinutes,
        cooldownLeft: Math.max(0, cool + S.cooldownMinutes * 60000 - now()), now: now() });
    }

    if ((mm = p.match(/^\/scan\/([a-z0-9]+)\/(assist|sabotage)$/)) && m === "POST") {
      if (!S.active) return json({ error: "The hunt is paused." }, 400);
      const st = cfg.stations.find(s => s.code === mm[1]);
      if (!st) return json({ error: "Unknown QR." }, 404);
      const b = await body(req);
      const target = (await targetsFor(cfg, st, me)).find(t => t.id === +b.teamId);
      if (!target) return json({ error: "That team can’t be affected here." }, 400);
      const pr = await getProg(me.id);
      if (me.route.some((r, i) => r.station_id === st.id && i <= pr.progress)) return json({ error: "Not allowed." }, 400);
      const log = { from: me.id, fromName: me.name, to: target.id, toName: target.name, stationName: st.name };

      if (mm[2] === "assist") {
        if (target.assisted) return json({ error: "You already helped this team here." }, 400);
        await put(`assist/${me.id}/${target.id}/${st.id}`, { at: now() });
        await addEvent(target.id, "assist", `🤝 ${me.name} found one of your QR codes and sent you its location: “${st.location || st.name}”`, st.id);
        await addLog({ type: "assist", ...log }); await bump(me.id, "assists");
        return json({ ok: true, message: `Location sent to ${target.name}. Good sportsmanship!` });
      }
      const cool = (await get(`cool/${me.id}`)) || 0, cdLeft = cool + S.cooldownMinutes * 60000 - now();
      if (cdLeft > 0) return json({ error: `Your sabotage is recharging (${Math.ceil(cdLeft / 1000)}s).`, cooldownLeft: cdLeft }, 429);
      if (target.locked) return json({ error: "That clue is already jammed." }, 400);
      await put(`lock/${target.id}/${st.id}`, { until: now() + S.sabotageMinutes * 60000, by: me.id, byName: me.name, at: now() });
      await put(`cool/${me.id}`, now());
      await addEvent(target.id, "sabotage", `💥 Someone sabotaged one of your QR codes! You can't read its clue for ${S.sabotageMinutes} minutes.`, st.id);
      await addLog({ type: "sabotage", ...log }); await bump(me.id, "sabotages");
      await put(`hit/${target.id}/${pad(now())}-${rid()}`, { by: me.id, station: st.id });
      return json({ ok: true, cooldownLeft: S.cooldownMinutes * 60000, message: `${target.name} is locked out of this clue for ${S.sabotageMinutes} minutes.` });
    }
    return json({ error: "not found" }, 404);
  } catch (e) { console.error(e); return json({ error: "Server error: " + e.message }, 500); }
};

// ---------- admin ----------
async function admin(req, p, m, url) {
  if (p === "/admin/login" && m === "POST") {
    const b = await body(req);
    if (!safeEq(String(b.password || ""), process.env.ADMIN_PASSWORD)) return json({ error: "Wrong admin password." }, 401);
    return json({ ok: true }, 200, setCookie({ a: 1 }));
  }
  if (!isAdmin(req)) return json({ error: "admin" }, 401);
  const cfg = await getCfg(), b = ["POST", "PUT"].includes(m) ? await body(req) : {};
  let mm;

  if (p === "/admin/state") {
    const lb = await leaderboard(cfg, true);
    const lockKeys = await keys("lock/");
    const locks = (await Promise.all(lockKeys.map(async k => ({ k, ...(await get(k)) }))))
      .filter(l => l.until > now()).map(l => { const [, v, s] = l.k.split("/"); return { victimId: +v, stationId: +s, victim: cfg.teams.find(t => t.id === +v)?.name || "?", station: stationOf(cfg, +s)?.name || "?", byTeam: l.byName, until: l.until }; });
    const logKeys = (await keys("log/")).slice(-120).reverse();
    const log = (await Promise.all(logKeys.map(get))).filter(Boolean);
    const teams = cfg.teams.map(t => { const r = lb.find(x => x.id === t.id); return { id: t.id, name: t.name, password: t.password, start_clue: t.start_clue, route: t.route, effective: t.route.map((_, i) => clueAt(cfg, t, i)), startEffective: startClueOf(cfg, t), progress: r.progress, total: r.total, finishedAt: r.finishedAt }; })
      .sort((a, b) => a.name.localeCompare(b.name));
    return json({ settings: cfg.settings, teams, stations: cfg.stations, locks, leaderboard: lb, log, now: now() });
  }
  if (p === "/admin/settings" && m === "PUT") {
    const s = cfg.settings;
    if (b.active !== undefined) s.active = !!b.active;
    if (b.sabotageMinutes !== undefined) s.sabotageMinutes = Math.max(1, Math.min(120, +b.sabotageMinutes || 10));
    if (b.cooldownMinutes !== undefined) s.cooldownMinutes = Math.max(0, Math.min(60, +b.cooldownMinutes || 0));
    if (b.eventName !== undefined) s.eventName = clean(b.eventName, 60) || "Hasmukh Karkhana";
    if (b.finale !== undefined) s.finale = clean(b.finale, 300) || "You cracked the final clue! Run to the organisers and claim your treasure.";
    await saveCfg(cfg); return json(s);
  }
  if (p === "/admin/stations" && m === "POST") {
    const name = clean(b.name, 80); if (!name) return json({ error: "Name required." }, 400);
    cfg.stations.push({ id: newId(cfg), code: newCode(), name, location: clean(b.location, 200), riddle: clean(b.riddle, 600) });
    await saveCfg(cfg); return json({ ok: true });
  }
  if ((mm = p.match(/^\/admin\/stations\/(\d+)$/))) {
    const id = +mm[1], s = stationOf(cfg, id); if (!s) return json({ error: "Not found" }, 404);
    if (m === "PUT") { s.name = clean(b.name, 80) || s.name; s.location = clean(b.location, 200); if (b.riddle !== undefined) s.riddle = clean(b.riddle, 600); await saveCfg(cfg); return json({ ok: true }); }
    if (m === "DELETE") {
      const usedBy = cfg.teams.map(t => ({ team: t.name, step: t.route.findIndex(r => r.station_id === id) + 1 })).filter(x => x.step > 0);
      if (usedBy.length && url.searchParams.get("force") !== "1")
        return json({ error: `“${s.name}” is used in ${usedBy.map(u => `${u.team} (step ${u.step})`).join(", ")}.`, usedBy }, 409);
      for (const t of cfg.teams) {   // each route is independent: only routes that used this QR change
        const idx = t.route.findIndex(r => r.station_id === id); if (idx < 0) continue;
        const pr = await getProg(t.id), wasDone = idx < Math.min(pr.progress, t.route.length);
        t.route = t.route.filter(r => r.station_id !== id);
        if (wasDone) await put(`prog/${t.id}`, { ...pr, progress: Math.max(0, pr.progress - 1) });
      }
      cfg.stations = cfg.stations.filter(x => x.id !== id);
      await saveCfg(cfg);
      await Promise.all((await keys("lock/")).filter(k => +k.split("/")[2] === id).concat((await keys("assist/")).filter(k => +k.split("/")[3] === id)).map(k => S_().delete(k)));
      return json({ ok: true });
    }
  }
  if (p === "/admin/teams" && m === "POST") {
    const name = clean(b.name, 60), pw = String(b.password || "").trim();
    if (!name || pw.length < 3) return json({ error: "Team name and a password (3+ characters) are required." }, 400);
    if (cfg.teams.some(t => t.name.toLowerCase() === name.toLowerCase())) return json({ error: "That team name is taken." }, 400);
    cfg.teams.push({ id: newId(cfg), name, password: pw, start_clue: clean(b.start_clue, 600), route: [] });
    await saveCfg(cfg); return json({ ok: true, id: cfg.nextId - 1 });
  }
  if ((mm = p.match(/^\/admin\/teams\/(\d+)(\/reset)?$/))) {
    const id = +mm[1], t = cfg.teams.find(x => x.id === id); if (!t) return json({ error: "Not found" }, 404);
    if (mm[2] && m === "POST") { await Promise.all([S_().delete(`prog/${id}`), S_().delete(`cool/${id}`), S_().delete(`seen/${id}`), delPrefix(`ev/${id}/`), delPrefix(`lock/${id}/`), delPrefix(`hit/${id}/`)]); return json({ ok: true }); }
    if (m === "PUT") {
      if (b.name !== undefined) { const n = clean(b.name, 60); if (n && cfg.teams.some(x => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) return json({ error: "That team name is taken." }, 400); if (n) t.name = n; }
      if (b.start_clue !== undefined) t.start_clue = clean(b.start_clue, 600);
      if (b.password !== undefined) { const pw = String(b.password).trim(); if (pw.length < 3) return json({ error: "Password needs 3+ characters." }, 400); t.password = pw; }
      let info = {};
      if (Array.isArray(b.route)) {
        const next = b.route.filter(r => stationOf(cfg, +r.station_id)).map(r => ({ station_id: +r.station_id, clue: clean(r.clue, 600) }));
        const seen = new Set();
        for (const r of next) {
          if (seen.has(r.station_id)) return json({ error: `“${stationOf(cfg, r.station_id).name}” appears twice in this route. A QR can be used only once per route (different teams can share it).` }, 400);
          seen.add(r.station_id);
        }
        // Keep progress honest: a team only keeps credit for the leading steps of the new route it has really scanned.
        const pr = await getProg(id), done = new Set(t.route.slice(0, Math.min(pr.progress, t.route.length)).map(r => r.station_id));
        let np = 0; while (np < next.length && done.has(next[np].station_id)) np++;
        t.route = next;
        if (np !== pr.progress) await put(`prog/${id}`, { progress: np, lastAt: pr.lastAt, finishedAt: np >= next.length && next.length > 0 ? pr.finishedAt || pr.lastAt : null });
        info = { progress: np, before: pr.progress };
      }
      await saveCfg(cfg); return json({ ok: true, ...info });
    }
    if (m === "DELETE") {
      cfg.teams = cfg.teams.filter(x => x.id !== id); await saveCfg(cfg);
      const assists = (await keys("assist/")).filter(k => { const [, f, to] = k.split("/"); return +f === id || +to === id; });
      const locks = (await keys("lock/")).filter(k => +k.split("/")[1] === id);
      await Promise.all([S_().delete(`prog/${id}`), S_().delete(`cool/${id}`), S_().delete(`seen/${id}`), S_().delete(`stat/${id}`), delPrefix(`ev/${id}/`), delPrefix(`hit/${id}/`), ...assists.map(k => S_().delete(k)), ...locks.map(k => S_().delete(k))]);
      return json({ ok: true });
    }
  }
  if (p === "/admin/autoroute" && m === "POST") {
    // Independent routes of K QRs each (default 7). Many random restarts; the best layout is the one where teams
    // (1) never stand at the same QR on the same step, (2) share as few QRs as possible, (3) share no QR pairs back-to-back, (4) use every QR evenly.
    const ids = cfg.stations.map(x => x.id), T = cfg.teams.length;
    if (!ids.length || !T) return json({ error: "Add stations and teams first." }, 400);
    const K = Math.max(1, Math.min(ids.length, +b.perTeam || 7));
    const shuf = a => { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
    const build = () => {
      const use = Object.fromEntries(ids.map(i => [i, 0])), routes = [], sets = [], posUse = [], pairs = new Set();
      for (let t = 0; t < T; t++) {
        // choose the K least-used QRs, preferring ones that overlap least with earlier teams' sets
        const pool = shuf(ids).sort((x, y) => use[x] - use[y]);
        const set = pool.slice(0, K); set.forEach(i => use[i]++);
        // order: for each step pick the QR that fewest earlier teams already use at that step, never repeating a back-to-back pair
        const left = set.slice(), order = [];
        for (let i = 0; i < K; i++) {
          const prev = order[i - 1];
          const cand = shuf(left).map(q => ({ q, c: (posUse[i]?.[q] || 0) * 100 + (prev != null && (pairs.has(prev + ">" + q)) ? 10 : 0) + Math.random() }));
          cand.sort((x, y) => x.c - y.c); const q = cand[0].q;
          order.push(q); left.splice(left.indexOf(q), 1); (posUse[i] ||= {})[q] = (posUse[i][q] || 0) + 1;
        }
        order.forEach((q, i) => { if (i) pairs.add(order[i - 1] + ">" + q); });
        routes.push(order); sets.push(new Set(set));
      }
      let same = 0, overlap = 0, adj = 0; const seenPair = new Set();
      for (let i = 0; i < K; i++) { const c = {}; routes.forEach(r => { c[r[i]] = (c[r[i]] || 0) + 1; }); Object.values(c).forEach(n => { if (n > 1) same += n * (n - 1) / 2; }); }
      for (let a = 0; a < T; a++) for (let c = a + 1; c < T; c++) { let o = 0; sets[a].forEach(q => { if (sets[c].has(q)) o++; }); overlap += o * o; }
      routes.forEach(r => r.forEach((q, i) => { if (i) { const k = r[i - 1] + ">" + q; if (seenPair.has(k)) adj++; seenPair.add(k); } }));
      const u = Object.values(use), spread = Math.max(...u) - Math.min(...u);
      return { routes, same, overlap, adj, score: same * 1000 + overlap * 6 + adj * 20 + spread * 30 };
    };
    let best = null; for (let n = 0; n < 400; n++) { const r = build(); if (!best || r.score < best.score) best = r; if (best.score === 0) break; }
    cfg.teams.forEach((t, k) => { t.route = best.routes[k].map(id => ({ station_id: id, clue: "" })); t.start_clue = ""; });
    await saveCfg(cfg); await delPrefix("prog/");
    return json({ ok: true, teams: T, steps: K, samePosition: best.same, shortOfStations: ids.length < 7 && !(+b.perTeam) });
  }
  if (p === "/admin/reset" && m === "POST") {
    await Promise.all(["prog/", "ev/", "lock/", "assist/", "cool/", "seen/", "log/", "stat/", "hit/"].map(delPrefix));
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/admin\/locks\/(\d+)\/(\d+)$/)) && m === "DELETE") { await S_().delete(`lock/${mm[1]}/${mm[2]}`); return json({ ok: true }); }
  return json({ error: "not found" }, 404);
}

export const config = { path: "/api/*" };
