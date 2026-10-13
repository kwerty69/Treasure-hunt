// QR Treasure Hunt API — Netlify Function (v2) + Netlify Blobs storage.
// Every piece of mutable state lives under its own key, so simultaneous scans by different teams never overwrite each other.
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const store = getStore({ name: "hunt", consistency: "strong" });
const now = () => Date.now();
const pad = n => String(n).padStart(15, "0");
const rid = () => crypto.randomBytes(3).toString("hex");
const clean = (s, n = 400) => String(s ?? "").trim().slice(0, n);
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const json = (b, status = 200, headers = {}) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

// ---------- storage helpers ----------
const get = k => store.get(k, { type: "json" });
const put = (k, v) => store.setJSON(k, v);
const keys = async prefix => (await store.list({ prefix })).blobs.map(b => b.key).sort();
const delPrefix = async prefix => { await Promise.all((await keys(prefix)).map(k => store.delete(k))); };
const defaultCfg = () => ({
  settings: { active: true, sabotageMinutes: 10, cooldownMinutes: 3, eventName: "Campus Treasure Hunt" },
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
    if (p.startsWith("/admin")) return await admin(req, p, m);
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
      const revealed = me.route.slice(0, progress).map((r, idx) => ({ idx, clue: r.clue, station: stationOf(cfg, r.station_id)?.name || "" }));
      const seenTs = (await get(`seen/${me.id}`)) || 0;
      const evKeys = (await keys(`ev/${me.id}/`)).slice(-30).reverse();
      const events = (await Promise.all(evKeys.map(async k => ({ id: k, ...(await get(k)) }))))
        .filter(e => e.at).map(e => ({ id: e.id, type: e.type, message: e.message, created_at: e.at, seen: e.at <= seenTs }));
      return json({ eventName: S.eventName, active: S.active, team: { id: me.id, name: me.name }, progress, total,
        finished: total > 0 && progress >= total, startClue: me.start_clue, revealed, events, unseen: events.filter(e => !e.seen).length,
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
        return json({ ...base, status: finished ? "finished" : "advance", clue: cur.clue, step: p0 + 1, total });
      }
      if (doneIdx >= 0) {
        if (lock) return json({ ...base, status: "locked", until: lock.until, now: now() });
        return json({ ...base, status: "replay", clue: route[doneIdx].clue, step: doneIdx + 1, total });
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
      return json({ ok: true, cooldownLeft: S.cooldownMinutes * 60000, message: `${target.name} is locked out of this clue for ${S.sabotageMinutes} minutes.` });
    }
    return json({ error: "not found" }, 404);
  } catch (e) { console.error(e); return json({ error: "Server error: " + e.message }, 500); }
};

// ---------- admin ----------
async function admin(req, p, m) {
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
    const teams = cfg.teams.map(t => { const r = lb.find(x => x.id === t.id); return { id: t.id, name: t.name, password: t.password, start_clue: t.start_clue, route: t.route, progress: r.progress, total: r.total, finishedAt: r.finishedAt }; })
      .sort((a, b) => a.name.localeCompare(b.name));
    return json({ settings: cfg.settings, teams, stations: cfg.stations, locks, leaderboard: lb, log, now: now() });
  }
  if (p === "/admin/settings" && m === "PUT") {
    const s = cfg.settings;
    if (b.active !== undefined) s.active = !!b.active;
    if (b.sabotageMinutes !== undefined) s.sabotageMinutes = Math.max(1, Math.min(120, +b.sabotageMinutes || 10));
    if (b.cooldownMinutes !== undefined) s.cooldownMinutes = Math.max(0, Math.min(60, +b.cooldownMinutes || 0));
    if (b.eventName !== undefined) s.eventName = clean(b.eventName, 60) || "Campus Treasure Hunt";
    await saveCfg(cfg); return json(s);
  }
  if (p === "/admin/stations" && m === "POST") {
    const name = clean(b.name, 80); if (!name) return json({ error: "Name required." }, 400);
    cfg.stations.push({ id: newId(cfg), code: newCode(), name, location: clean(b.location, 200) });
    await saveCfg(cfg); return json({ ok: true });
  }
  if ((mm = p.match(/^\/admin\/stations\/(\d+)$/))) {
    const id = +mm[1], s = stationOf(cfg, id); if (!s) return json({ error: "Not found" }, 404);
    if (m === "PUT") { s.name = clean(b.name, 80) || s.name; s.location = clean(b.location, 200); await saveCfg(cfg); return json({ ok: true }); }
    if (m === "DELETE") {
      cfg.stations = cfg.stations.filter(x => x.id !== id);
      cfg.teams.forEach(t => { t.route = t.route.filter(r => r.station_id !== id); });
      await saveCfg(cfg); return json({ ok: true });
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
    if (mm[2] && m === "POST") { await Promise.all([store.delete(`prog/${id}`), store.delete(`cool/${id}`), store.delete(`seen/${id}`), delPrefix(`ev/${id}/`), delPrefix(`lock/${id}/`)]); return json({ ok: true }); }
    if (m === "PUT") {
      if (b.name !== undefined) { const n = clean(b.name, 60); if (n && cfg.teams.some(x => x.id !== id && x.name.toLowerCase() === n.toLowerCase())) return json({ error: "That team name is taken." }, 400); if (n) t.name = n; }
      if (b.start_clue !== undefined) t.start_clue = clean(b.start_clue, 600);
      if (b.password !== undefined) { const pw = String(b.password).trim(); if (pw.length < 3) return json({ error: "Password needs 3+ characters." }, 400); t.password = pw; }
      if (Array.isArray(b.route)) t.route = b.route.filter(r => stationOf(cfg, +r.station_id)).map(r => ({ station_id: +r.station_id, clue: clean(r.clue, 600) }));
      await saveCfg(cfg); return json({ ok: true });
    }
    if (m === "DELETE") {
      cfg.teams = cfg.teams.filter(x => x.id !== id); await saveCfg(cfg);
      const assists = (await keys("assist/")).filter(k => { const [, f, to] = k.split("/"); return +f === id || +to === id; });
      const locks = (await keys("lock/")).filter(k => +k.split("/")[1] === id);
      await Promise.all([store.delete(`prog/${id}`), store.delete(`cool/${id}`), store.delete(`seen/${id}`), store.delete(`stat/${id}`), delPrefix(`ev/${id}/`), ...assists.map(k => store.delete(k)), ...locks.map(k => store.delete(k))]);
      return json({ ok: true });
    }
  }
  if (p === "/admin/reset" && m === "POST") {
    await Promise.all(["prog/", "ev/", "lock/", "assist/", "cool/", "seen/", "log/", "stat/"].map(delPrefix));
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/admin\/locks\/(\d+)\/(\d+)$/)) && m === "DELETE") { await store.delete(`lock/${mm[1]}/${mm[2]}`); return json({ ok: true }); }
  return json({ error: "not found" }, 404);
}

export const config = { path: "/api/*" };
