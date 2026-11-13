// public-openings (verify_jwt OFF, read-only) — used by the website "This week only" section.
// GET → { coach, price, weeks: [{ ws, slots: [{ day, time, date }] }] }
// One-time openings this week + next: main coach, open that week (same rule as portal extra lessons),
// but ONLY times a weekly lesson normally holds (a regular kid is away). Permanent openings are left out
// (the website already shows those under Weekly spots). Flip Lab only. week.ts = copy of /week.js.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildWeek, timeVal, DAYS, priceFor } from "./week.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=60" } });
const TZ = "America/New_York";
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function nyNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}
const mondayOf = (ymd: string) => { const d = new Date(ymd + "T12:00:00Z"), w = (d.getUTCDay() + 6) % 7; return addDays(ymd, -w); };
const dateOf = (ws: string, day: string) => addDays(ws, DAYS.indexOf(day));
function minsUntil(ws: string, day: string, time: string) {
  const n = nyNow(), d = dateOf(ws, day);
  return Math.round((Date.parse(d) - Date.parse(n.ymd)) / 864e5) * 1440 + timeVal(time) - n.min;
}
const mdIn = (md: string, a: string, b: string) => a <= b ? md >= a && md <= b : md >= a || md <= b;
const sameCoach = (a: string, c: string) => !a || !c || a === c || a.replace(/^coach\s+/i, "") === c.replace(/^coach\s+/i, "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: g } = await db.from("gyms").select("id").eq("slug", "fliplab").maybeSingle();
    if (!g) return json({ error: "not found" }, 404);
    const gym = g.id;
    const [{ data: cs }, { data: lessons }, { data: slots }, { data: seasons }] = await Promise.all([
      db.from("cal_settings").select("main_coach").eq("gym_id", gym).maybeSingle(),
      db.from("private_lessons").select("*").eq("gym_id", gym).not("status", "in", '("Cancelled","Dropped")'),
      db.from("available_slots").select("day,time,coach,is_summer,season_id,extra").eq("gym_id", gym).eq("active", true),
      db.from("seasons").select("*").eq("gym_id", gym)]);
    const main = String(cs?.main_coach || "Coach Steve");
    const thisMon = mondayOf(nyNow().ymd), weeks = [];
    for (const ws of [thisMon, addDays(thisMon, 7)]) {
      const we = addDays(ws, 6);
      const [{ data: exs }, { data: offs }] = await Promise.all([
        db.from("schedule_exceptions").select("*").eq("gym_id", gym).eq("week_start", ws).not("status", "in", '("Deleted","Expired")'),
        db.from("days_off").select("coach,start_date,end_date").eq("gym_id", gym).lte("start_date", we).gte("end_date", ws)]);
      const live = (buildWeek(lessons || [], exs || [], ws, we) as any[]).filter(p => p.status !== "Cancelled");
      const regular = (buildWeek(lessons || [], [], ws, we) as any[]).filter(p => p.status !== "Cancelled");   // the normal week, no changes
      const holds = (rows: any[], s: any) => rows.some(p => p.day === s.day && p.time === s.time && (!p.coach || p.coach === "TBD" || sameCoach(p.coach, s.coach)));
      const md = ws.slice(5, 10);
      const se = (seasons || []).filter(x => mdIn(md, x.start_md, x.end_md)).sort((a, c) => (c.sort || 0) - (a.sort || 0))[0];
      const seen = new Set<string>();
      const out = (slots || []).filter(s => {
        const sSe = s.season_id || (s.is_summer ? "fliplab:summer" : "fliplab:school");
        if (se && sSe !== se.id) return false;
        if (s.extra?.test) return false;
        if (!sameCoach(s.coach, main)) return false;
        const k = s.day + "|" + s.time; if (seen.has(k)) return false;
        if (minsUntil(ws, s.day, s.time) <= 60) return false;
        const dt = dateOf(ws, s.day);
        if ((offs || []).some(o => dt >= o.start_date && dt <= o.end_date && (!o.coach || sameCoach(o.coach, s.coach)))) return false;   // days off
        if (holds(live, s)) return false;          // taken this week
        if (!holds(regular, s)) return false;      // permanent opening → shown as a weekly spot, not here
        seen.add(k); return true;
      }).sort((a, c) => DAYS.indexOf(a.day) - DAYS.indexOf(c.day) || timeVal(a.time) - timeVal(c.time))
        .map(s => ({ day: s.day, time: s.time, date: dateOf(ws, s.day) }));
      weeks.push({ ws, slots: out });
    }
    return json({ coach: main, price: priceFor("30 min", "Solo"), weeks });
  } catch (e) {
    return json({ error: "failed" }, 500);
  }
});
