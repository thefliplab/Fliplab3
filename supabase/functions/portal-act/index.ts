// FlipLab 3.0 — Parent portal actions (verify_jwt ON; caller must be a logged-in portal parent).
// Everything is worked out here with the same week logic as the admin page (week.ts = copy of /week.js),
// so parents only ever get their own kids' lessons — never other families' data.
//   { action: 'load' }                                   → { kids, cancel_hrs, weeks: [{ ws, items: [...] }] }  (this week + 3)
//   { action: 'options', lesson_id, ws }                 → { slots: [{ day, time }] }  open times that week, same coach
//   { action: 'cancel',  lesson_id, ws, ok_late? }       → { ok } | { late: true }  (late = under cancel_hrs; parent must confirm)
//   { action: 'move',    lesson_id, ws, day, time }      → { ok }
//   { action: 'undo',    ex_id }                         → { ok }  (only the parent's own change, before the lesson)
//   { action: 'classes' }                                → { classes, clinics }  the kids' weekly classes (enrolled / waitlisted) + upcoming clinics
//   { action: 'rsvp', schedule_id, student_id, ws, answer } → { ok }  answer 'yes' | 'no' | null (no text to Steve; shows on Schedule)
//   { action: 'class_enroll', schedule_id, student_id }  → { ok }  waitlisted kid takes an open spot right away
//   { action: 'waitlist_leave', schedule_id, student_id } → { ok }
//   { action: 'clinic_signup', schedule_id, student_id } → { ok }
// Every change texts gym_settings 'portal_notify' (Steve's 214 phone) through SMSGate and is saved in schedule_exceptions
// with extra.by = 'parent' (Dashboard shows them).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildWeek, timeVal, DAYS } from "./week.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const p10 = (p: unknown) => String(p || "").replace(/\D/g, "").slice(-10);
const TZ = "America/New_York";
const SHORT: Record<string, string> = { Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu", Friday: "Fri", Saturday: "Sat", Sunday: "Sun" };
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// New York "now" as YYYY-MM-DD + minutes since midnight
function nyNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}
const mondayOf = (ymd: string) => { const d = new Date(ymd + "T12:00:00Z"), w = (d.getUTCDay() + 6) % 7; return addDays(ymd, -w); };
const dateOf = (ws: string, day: string) => addDays(ws, DAYS.indexOf(day));
// Minutes from now until a lesson (NY time); negative = already started
function minsUntil(ws: string, day: string, time: string) {
  const n = nyNow(), d = dateOf(ws, day);
  const days = Math.round((Date.parse(d) - Date.parse(n.ymd)) / 864e5);
  return days * 1440 + timeVal(time) - n.min;
}
const nice = (ws: string, day: string, time: string) => { const d = new Date(dateOf(ws, day) + "T12:00:00Z"); return `${SHORT[day]} ${d.getUTCMonth() + 1}/${d.getUTCDate()} ${time}`; };
const mdIn = (md: string, a: string, b: string) => a <= b ? md >= a && md <= b : md >= a || md <= b;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const URL_ = Deno.env.get("SUPABASE_URL")!;
  const userC = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: u } = await userC.auth.getUser();
  if (!u?.user) return json({ error: "Please log in again." }, 401);
  const db = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: acct } = await db.from("parent_accounts").select("gym_id,phone").eq("user_id", u.user.id).maybeSingle();
  if (!acct) return json({ error: "Please log in again." }, 401);
  const gym = acct.gym_id;
  const b = await req.json().catch(() => ({}));

  // The parent's kids
  const { data: st } = await db.from("students").select("id,first_name,last_name,parent_phone,parent_name,parent_email,active").eq("gym_id", gym).ilike("parent_phone", `%${acct.phone.slice(-4)}%`);
  const kids = (st || []).filter(s => p10(s.parent_phone) === acct.phone && s.active !== false);
  const kidIds = new Set(kids.map(k => k.id));
  if (!kids.length) return json({ error: "No students found for this phone." });
  const isTest = [...kidIds].every(id => id.startsWith("TEST-"));

  const { data: setRow } = await db.from("gym_settings").select("value").eq("gym_id", gym).eq("key", "settings").maybeSingle();
  const cancelHrs = +(setRow?.value?.cancel_hrs) || 24;

  // All lessons (needed for Shared counting + who holds a slot) and one week's changes
  const { data: lessons } = await db.from("private_lessons").select("*").eq("gym_id", gym).not("status", "in", '("Cancelled","Dropped")');
  async function week(ws: string) {
    const { data: exs } = await db.from("schedule_exceptions").select("*").eq("gym_id", gym).eq("week_start", ws).not("status", "in", '("Deleted","Expired")');
    return { exs: exs || [], rows: buildWeek(lessons || [], exs || [], ws, addDays(ws, 6)) as any[] };
  }
  const thisMon = mondayOf(nyNow().ymd);
  const validWs = (ws: string) => typeof ws === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ws) && ws >= thisMon && ws <= addDays(thisMon, 21) && mondayOf(ws) === ws;
  const myLesson = (id: string) => (lessons || []).find(l => l.id === id && kidIds.has(l.student_id));

  async function openSlots(ws: string, coach: string, rows: any[]) {
    const [{ data: slots }, { data: seasons }] = await Promise.all([
      db.from("available_slots").select("id,day,time,coach,active,is_summer,season_id,extra").eq("gym_id", gym).eq("active", true),
      db.from("seasons").select("*").eq("gym_id", gym)]);
    const md = ws.slice(5, 10);
    const se = (seasons || []).filter(x => mdIn(md, x.start_md, x.end_md)).sort((a, c) => (c.sort || 0) - (a.sort || 0))[0];
    const live = rows.filter(p => p.status !== "Cancelled"), seen = new Set<string>();
    const sameCoach = (a: string, c: string) => !a || !c || a === c || a.replace(/^coach\s+/i, "") === c.replace(/^coach\s+/i, "");
    return (slots || []).filter(s => {
      const sSe = s.season_id || (s.is_summer ? "fliplab:summer" : "fliplab:school");
      if (se && sSe !== se.id) return false;
      if (!!(s.extra?.test) !== isTest) return false;                 // test slots only for test students (and only those)
      if (!sameCoach(s.coach, coach)) return false;
      const k = s.day + "|" + s.time; if (seen.has(k)) return false;
      if (minsUntil(ws, s.day, s.time) <= 60) return false;            // past or starting within the hour
      if (live.some(p => p.day === s.day && p.time === s.time && (!p.coach || p.coach === "TBD" || sameCoach(p.coach, s.coach)))) return false;
      seen.add(k); return true;
    }).sort((a, c) => DAYS.indexOf(a.day) - DAYS.indexOf(c.day) || timeVal(a.time) - timeVal(c.time)).map(s => ({ day: s.day, time: s.time }));
  }

  async function notify(text: string) {
    const { data: n } = await db.from("gym_settings").select("value").eq("gym_id", gym).eq("key", "portal_notify").maybeSingle();
    const to = p10(typeof n?.value === "string" ? n.value : n?.value?.phone);
    const usr = Deno.env.get("SMSGATE_USER"), pw = Deno.env.get("SMSGATE_PASS");
    if (to.length !== 10 || !usr || !pw) return;
    await fetch("https://api.sms-gate.app/3rdparty/v1/message", { method: "POST", headers: { Authorization: "Basic " + btoa(usr + ":" + pw), "Content-Type": "application/json" },
      body: JSON.stringify({ textMessage: { text }, phoneNumbers: ["+1" + to], withDeliveryReport: false }) }).catch(() => {});
  }
  const kidName = (id: string) => { const k = kids.find(x => x.id === id); return k ? `${k.first_name} ${k.last_name || ""}`.trim() : "A student"; };

  // ---------- load ----------
  if (b.action === "load") {
    const weeks = [];
    for (let i = 0; i < 4; i++) {
      const ws = addDays(thisMon, i * 7), { exs, rows } = await week(ws);
      const items = rows.filter(p => kidIds.has(p.student_id)).map(p => {
        const baseId = p.exType === "Add" ? null : p.id;
        const ex = baseId ? exs.find(e => e.lesson_id === baseId && e.type !== "Add") : exs.find(e => "EX_ONLY_" + e.id === p.id || p.id.endsWith("_EX_" + e.id));
        const mins = minsUntil(ws, p.day, p.time);
        const mine = !!ex && ex.extra?.by === "parent";
        return { id: p.id, student_id: p.student_id, day: p.day, time: p.time, date: dateOf(ws, p.day), coach: p.coach, duration: p.duration, lesson_type: p.lesson_type,
          status: p.status, kind: p.exType || "", past: mins <= 0,
          can_change: !!baseId && (!ex || ex.type === "PriceOverride") && mins > 0 && p.status !== "Cancelled",
          undo_id: mine && ex.status === "Active" && minsUntil(ws, ex.base_day || p.bday, ex.base_time || p.btime) > 0 && (p.exType !== "Move" || mins > 0) ? ex.id : null,
          late: !!ex?.extra?.late, from: p.exType === "Move" ? { day: p.bday, time: p.btime } : null };
      }).filter(it => it.kind !== "MoveOrigin").sort((a, c) => a.date.localeCompare(c.date) || timeVal(a.time) - timeVal(c.time));
      weeks.push({ ws, items });
    }
    return json({ kids: kids.map(k => ({ id: k.id, first_name: k.first_name, last_name: k.last_name })), cancel_hrs: cancelHrs, weeks });
  }

  // ---------- options / cancel / move: one of the parent's weekly lessons in one week ----------
  if (["options", "cancel", "move"].includes(b.action)) {
    const L = myLesson(String(b.lesson_id || "")), ws = String(b.ws || "");
    if (!L || !validWs(ws)) return json({ error: "That lesson can't be changed here. Text Coach Steve." });
    const { exs, rows } = await week(ws);
    const p = rows.find(r => r.id === L.id);
    if (!p || p.status === "Cancelled") return json({ error: "That lesson isn't on for that week." });
    const old = exs.find(e => e.lesson_id === L.id && e.type !== "Add");
    if (old && old.type !== "PriceOverride") return json({ error: "That week was already changed. Text Coach Steve." });
    const mins = minsUntil(ws, p.day, p.time);
    if (mins <= 0) return json({ error: "That lesson already started." });
    const late = mins < cancelHrs * 60;

    if (b.action === "options") return json({ slots: await openSlots(ws, p.coach, rows), late, cancel_hrs: cancelHrs });

    const base = { gym_id: gym, lesson_id: L.id, student_id: L.student_id, student_name: L.student_name, coach: p.coach, base_day: p.day, base_time: p.time,
      week_start: ws, original_date: dateOf(ws, p.day), status: "Active", created_at: new Date().toISOString() };
    if (b.action === "cancel") {
      if (late && !b.ok_late) return json({ late: true, cancel_hrs: cancelHrs });
      if (old) {   // a price change doesn't matter once cancelled
        const { error: oe } = await db.from("schedule_exceptions").update({ status: "Deleted" }).eq("id", old.id);
        if (oe) return json({ error: "Couldn't save. Try again." }, 500);
      }
      const { error } = await db.from("schedule_exceptions").insert({ ...base, id: crypto.randomUUID(), type: "Cancel", notes: "Cancelled by parent (portal)" + (late ? " — LATE" : ""),
        extra: { by: "parent", late, phone: acct.phone } });
      if (error) return json({ error: "Couldn't save. Try again." }, 500);
      await notify(`Parent portal: ${kidName(L.student_id)} CANCELLED ${nice(ws, p.day, p.time)}${late ? ` — LATE (under ${cancelHrs} hrs)` : ""}`);
      return json({ ok: true });
    }
    // move
    const day = String(b.day || ""), time = String(b.time || "");
    if (old) return json({ error: "That week has a special price. Text Coach Steve to move it." });
    const ok = (await openSlots(ws, p.coach, rows)).some(s => s.day === day && s.time === time);
    if (!ok) return json({ error: "That time was just taken. Pick another." });
    const { error } = await db.from("schedule_exceptions").insert({ ...base, id: crypto.randomUUID(), type: "Move", new_day: day, new_time: time, new_coach: p.coach,
      notes: "Moved by parent (portal)" + (late ? " — LATE" : ""), extra: { by: "parent", late, phone: acct.phone } });
    if (error) return json({ error: "Couldn't save. Try again." }, 500);
    await notify(`Parent portal: ${kidName(L.student_id)} MOVED ${nice(ws, p.day, p.time)} → ${nice(ws, day, time)}${late ? " (late notice)" : ""}`);
    return json({ ok: true });
  }

  // ---------- classes + clinics ----------
  const fmtP = (p: string) => p.length === 10 ? `(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}` : p;
  const minsUntilDate = (ymd: string, time: string) => minsUntil(mondayOf(ymd), DAYS[(new Date(ymd + "T12:00:00Z").getUTCDay() + 6) % 7], time || "11:59 PM");
  const money = (c: any) => +String(c.price || "").replace(/[^0-9.]/g, "") || +(setRow?.value?.class_price) || 20;
  async function classInfo() {
    const [{ data: cs }, { data: en }] = await Promise.all([
      db.from("class_schedule").select("id,class_name,kind,day,time,duration,coach,price,max_students,clinic_date,age_group,active,ended_at,extra").eq("gym_id", gym).eq("active", true).is("ended_at", null),
      db.from("class_enrollments").select("id,schedule_id,student_id,status,enroll_date").eq("gym_id", gym).neq("status", "Dropped")]);
    const enr = en || [];
    const roster = (id: string) => enr.filter(e => e.schedule_id === id && e.status !== "Waitlisted");
    const wait = (id: string) => enr.filter(e => e.schedule_id === id && e.status === "Waitlisted").sort((a, c) => String(a.enroll_date || "").localeCompare(String(c.enroll_date || "")) || a.id.localeCompare(c.id));
    // a waitlisted kid can take a spot if their place in line fits in the open spots
    const canEnroll = (c: any, sid: string) => { const max = +c.max_students || 0, pos = wait(c.id).findIndex(e => e.student_id === sid) + 1;
      return pos > 0 && (!max || pos <= max - roster(c.id).length); };
    const all = (cs || []).filter(c => !!(c.extra?.test) === isTest || c.kind !== "clinic");   // test clinics only for test families (and only those)
    return { cs: all.filter(c => c.kind !== "clinic"), clin: all.filter(c => c.kind === "clinic"), enr, roster, wait, canEnroll };
  }
  // the next 4 class weeks (skips this week once the class has started)
  const classWeeks = (c: any) => { const out: string[] = []; for (let i = 0; i < 5 && out.length < 4; i++) { const ws = addDays(thisMon, i * 7); if (minsUntil(ws, c.day, c.time) > 0) out.push(ws); } return out; };

  if (b.action === "classes") {
    const I = await classInfo();
    const mine = I.cs.filter(c => I.enr.some(e => e.schedule_id === c.id && kidIds.has(e.student_id)));
    const wss = [...new Set(mine.flatMap(classWeeks))];
    const [{ data: rs }, { data: off }] = wss.length ? await Promise.all([
      db.from("class_rsvp").select("schedule_id,student_id,week_start,answer").eq("gym_id", gym).in("week_start", wss).in("student_id", [...kidIds]),
      db.from("class_week_off").select("schedule_id,week_start").eq("gym_id", gym).in("week_start", wss)]) : [{ data: [] }, { data: [] }];
    const classes = mine.flatMap(c => I.enr.filter(e => e.schedule_id === c.id && kidIds.has(e.student_id)).map(e => {
      const waiting = e.status === "Waitlisted", max = +c.max_students || 0;
      return { id: c.id, student_id: e.student_id, name: c.class_name, day: c.day, time: c.time, duration: c.duration, coach: c.coach, price: money(c),
        status: waiting ? "waitlist" : "enrolled", spots: max ? Math.max(0, max - I.roster(c.id).length) : null,
        pos: waiting ? I.wait(c.id).findIndex(x => x.student_id === e.student_id) + 1 : null, can_enroll: waiting && I.canEnroll(c, e.student_id),
        weeks: waiting ? [] : classWeeks(c).map(ws => ({ ws, date: dateOf(ws, c.day), off: (off || []).some(o => o.schedule_id === c.id && o.week_start === ws),
          answer: ((rs || []).find(r => r.schedule_id === c.id && r.student_id === e.student_id && r.week_start === ws) || {}).answer || null })) };
    }));
    const up = I.clin.filter(c => c.clinic_date && minsUntilDate(c.clinic_date, c.time) > 0).sort((a, c) => a.clinic_date.localeCompare(c.clinic_date));
    const { data: ck } = up.length ? await db.from("clinic_kids").select("schedule_id,student_id,paid").eq("gym_id", gym).in("schedule_id", up.map(c => c.id)) : { data: [] };
    const clinics = up.map(c => { const max = +c.max_students || 0, n = (ck || []).filter(k => k.schedule_id === c.id).length;
      return { id: c.id, name: c.class_name, date: c.clinic_date, time: c.time, duration: c.duration, coach: c.coach, ages: c.age_group, price: money(c),
        spots: max ? Math.max(0, max - n) : null, signed: (ck || []).filter(k => k.schedule_id === c.id && kidIds.has(k.student_id)).map(k => ({ student_id: k.student_id, paid: !!k.paid })) }; });
    return json({ classes, clinics });
  }

  if (["rsvp", "class_enroll", "waitlist_leave", "clinic_signup"].includes(b.action)) {
    const sid = String(b.student_id || ""), cid = String(b.schedule_id || "");
    if (!kidIds.has(sid)) return json({ error: "That can't be changed here. Text Coach Steve." });
    const I = await classInfo(), kid = kids.find(k => k.id === sid)!;
    const nm = kidName(sid);

    if (b.action === "clinic_signup") {
      const c = I.clin.find(x => x.id === cid);
      if (!c || !c.clinic_date || minsUntilDate(c.clinic_date, c.time) <= 0) return json({ error: "That clinic isn't open for sign-up. Text Coach Steve." });
      const { data: ck } = await db.from("clinic_kids").select("student_id").eq("gym_id", gym).eq("schedule_id", c.id);
      if ((ck || []).some(k => k.student_id === sid)) return json({ ok: true });
      const max = +c.max_students || 0;
      if (max && (ck || []).length >= max) return json({ error: "Sorry, that clinic just filled up. Text Coach Steve." });
      const { error } = await db.from("clinic_kids").insert({ gym_id: gym, schedule_id: c.id, kid_name: nm, student_id: sid, parent_name: kid.parent_name || null,
        phone: fmtP(acct.phone), email: kid.parent_email || null, amount: money(c), paid: false, notes: "Signed up in parent portal" });
      if (error) return json({ error: "Couldn't save. Try again." }, 500);
      const d = new Date(c.clinic_date + "T12:00:00Z");
      await notify(`Parent portal: ${nm} SIGNED UP for ${c.class_name} clinic (${d.getUTCMonth() + 1}/${d.getUTCDate()}) — ${(ck || []).length + 1}${max ? "/" + max : ""} kids`);
      return json({ ok: true });
    }

    const c = I.cs.find(x => x.id === cid), e = I.enr.find(x => x.schedule_id === cid && x.student_id === sid);
    if (!c || !e) return json({ error: "That can't be changed here. Text Coach Steve." });
    const when = `${SHORT[c.day] || c.day} ${c.time}`;

    if (b.action === "rsvp") {
      const ws = String(b.ws || ""), ans = b.answer === "yes" || b.answer === "no" ? b.answer : null;
      if (e.status === "Waitlisted" || !classWeeks(c).includes(ws)) return json({ error: "That class can't be changed now. Text Coach Steve." });
      const { data: off } = await db.from("class_week_off").select("schedule_id").eq("gym_id", gym).eq("schedule_id", cid).eq("week_start", ws);
      if ((off || []).length) return json({ error: "There's no class that week." });
      const { data: cur } = await db.from("class_rsvp").select("once").eq("gym_id", gym).eq("schedule_id", cid).eq("student_id", sid).eq("week_start", ws).maybeSingle();
      const { error } = await db.from("class_rsvp").upsert({ gym_id: gym, schedule_id: cid, student_id: sid, student_name: nm, week_start: ws, answer: ans,
        once: cur?.once || false, source: "portal", updated_at: new Date().toISOString() }, { onConflict: "gym_id,schedule_id,student_id,week_start" });
      if (error) return json({ error: "Couldn't save. Try again." }, 500);
      return json({ ok: true });
    }
    if (b.action === "class_enroll") {
      if (e.status !== "Waitlisted") return json({ ok: true });
      if (!I.canEnroll(c, sid)) return json({ error: "Sorry, that spot was just taken." });
      const { error } = await db.from("class_enrollments").update({ status: "Enrolled", enroll_date: nyNow().ymd }).eq("id", e.id);
      if (error) return json({ error: "Couldn't save. Try again." }, 500);
      const max = +c.max_students || 0;
      await notify(`Parent portal: ${nm} ENROLLED in ${c.class_name} (${when}) from the waitlist — ${I.roster(cid).length + 1}${max ? "/" + max : ""} kids`);
      return json({ ok: true });
    }
    // waitlist_leave
    if (e.status !== "Waitlisted") return json({ error: "To stop the class, text Coach Steve." });
    const { error } = await db.from("class_enrollments").update({ status: "Dropped", notes: "Left waitlist (parent portal)" }).eq("id", e.id);
    if (error) return json({ error: "Couldn't save. Try again." }, 500);
    await notify(`Parent portal: ${nm} LEFT the waitlist for ${c.class_name} (${when})`);
    return json({ ok: true });
  }

  // ---------- undo the parent's own change ----------
  if (b.action === "undo") {
    const { data: ex } = await db.from("schedule_exceptions").select("*").eq("gym_id", gym).eq("id", String(b.ex_id || "")).eq("status", "Active").maybeSingle();
    if (!ex || ex.extra?.by !== "parent" || !kidIds.has(ex.student_id)) return json({ error: "That can't be undone here. Text Coach Steve." });
    if (minsUntil(ex.week_start, ex.base_day, ex.base_time) <= 0 || (ex.type === "Move" && minsUntil(ex.week_start, ex.new_day, ex.new_time) <= 0)) return json({ error: "Too late to undo. Text Coach Steve." });
    // Getting the old spot back: make sure nobody took it meanwhile (Openings / drop-in)
    if (ex.type === "Cancel" || ex.type === "Move") {
      // taken = another kid was dropped in / moved into the old spot that week (regular shared partners were there already)
      const { rows } = await week(ex.week_start);
      const taken = rows.some(p => p.status !== "Cancelled" && p.day === ex.base_day && p.time === ex.base_time && p.student_id !== ex.student_id && (p.exType === "Add" || p.exType === "Move"));
      if (taken) return json({ error: "Someone already took that spot. Text Coach Steve." });
    }
    const { error: ue } = await db.from("schedule_exceptions").update({ status: "Deleted" }).eq("id", ex.id);
    if (ue) return json({ error: "Couldn't undo. Try again or text Coach Steve." }, 500);
    await notify(`Parent portal: ${kidName(ex.student_id)} UNDID their ${ex.type === "Cancel" ? "cancel" : "move"} — back on ${nice(ex.week_start, ex.base_day, ex.base_time)}`);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
});
