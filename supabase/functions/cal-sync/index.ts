// FlipLab 3.0 — Google Calendar sync (Supabase Edge Function "cal-sync")
// Called every minute by pg_cron while cal_queue has weeks waiting. For each queued week it builds the week's
// lessons with the same logic as the admin page (week.ts = copy of /week.js) and makes the Google calendar match:
// adds missing events, updates changed ones, deletes ones that no longer exist. It only ever touches events it
// created itself (private extended property fl3=1), so anything else on the calendar is left alone.
// Needs secret GOOGLE_SA_JSON (service-account key; the calendar must be shared with that account, "Make changes to events").
// Harmless to call: it only drains the queue. Settings live in cal_settings (Account → Calendar sync).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { buildWeek, timeVal, DAYS } from "./week.ts";

const TZ = "America/New_York";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// ---------- Google auth (service account JWT → access token) ----------
async function googleToken(): Promise<string> {
  const sa = JSON.parse(Deno.env.get("GOOGLE_SA_JSON") || "null");
  if (!sa?.private_key) throw new Error("GOOGLE_SA_JSON secret is missing");
  const b64u = (b: Uint8Array | string) => btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64u(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/calendar", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + claim)));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: head + "." + claim + "." + b64u(sig) }) });
  const j = await r.json(); if (!j.access_token) throw new Error("Google sign-in failed: " + JSON.stringify(j));
  return j.access_token;
}
async function gcal(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch("https://www.googleapis.com/calendar/v3" + path, { method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204 || r.status === 410) return null;            // deleted / already gone
  const j = await r.json(); if (!r.ok) throw new Error(method + " " + path.split("?")[0] + ": " + (j.error?.message || r.status));
  return j;
}

// ---------- helpers ----------
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const hhmm = (min: number) => String(Math.floor(min / 60)).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0") + ":00";
const minutes = (dur: string | null, dflt: number) => parseInt(String(dur || "")) || dflt;
// New York offset for a date (handles daylight saving) → used only for the list window
function nyOffset(ymd: string) { const d = new Date(ymd + "T12:00:00Z"); const s = d.toLocaleString("en-US", { timeZone: TZ, timeZoneName: "shortOffset" }); const m = s.match(/GMT([+-]\d+)/); return (m ? (+m[1] < 0 ? "-" : "+") + String(Math.abs(+m[1])).padStart(2, "0") : "-05") + ":00"; }

type Want = { key: string; body: Record<string, unknown> };

async function wantedEvents(gym: string, s: any, ws: string): Promise<Want[]> {
  const we = addDays(ws, 6);
  const [L, X, CS, CE, OFF] = await Promise.all([
    db.from("private_lessons").select("*").eq("gym_id", gym).not("status", "in", '("Cancelled","Dropped")'),
    db.from("schedule_exceptions").select("*").eq("gym_id", gym).eq("week_start", ws).not("status", "in", '("Deleted","Expired")'),
    s.class_on ? db.from("class_schedule").select("*").eq("gym_id", gym).eq("active", true) : Promise.resolve({ data: [] }),
    s.class_on ? db.from("class_enrollments").select("schedule_id,status").eq("gym_id", gym) : Promise.resolve({ data: [] }),
    db.from("class_week_off").select("schedule_id").eq("gym_id", gym).eq("week_start", ws),
  ]);
  for (const r of [L, X]) if ((r as any).error) throw new Error((r as any).error.message);
  const out: Want[] = [];
  const ev = (key: string, title: string, day: string, time: string, mins: number, desc: string, color?: string) => {
    const di = DAYS.indexOf(day), t = timeVal(time); if (di < 0 || t >= 9999) return;
    const date = addDays(ws, di), body: Record<string, unknown> = {
      summary: title, description: desc,
      start: { dateTime: date + "T" + hhmm(t), timeZone: TZ }, end: { dateTime: date + "T" + hhmm(t + mins), timeZone: TZ },
      reminders: { useDefault: false, overrides: [] },
    };
    if (color) body.colorId = color;
    const sig = JSON.stringify([title, desc, date, t, mins, color || ""]);
    body.extendedProperties = { private: { fl3: "1", key, sig } };
    out.push({ key, body });
  };
  // Lessons: one event per kid (shared kids stack, same as 2.0)
  buildWeek(L.data || [], X.data || [], ws, we).filter((p: any) => p.status !== "Cancelled").forEach((p: any) => {
    const other = !!(p.coach && s.main_coach && p.coach !== s.main_coach);
    ev("L|" + p.id + "|" + ws, p.student_name || "Lesson", p.day, p.time, minutes(p.duration, 30),
      [p.coach || "", p.lesson_type === "Shared" ? "Shared" : "", "FlipLab 3.0"].filter(Boolean).join(" · "), other ? (s.other_color || "4") : undefined);
  });
  // Classes: one event per class, unless "No class this week"
  const off = new Set((OFF.data || []).map((o: any) => o.schedule_id));
  (CS.data || []).forEach((c: any) => {
    if (off.has(c.id)) return;
    const n = (CE.data || []).filter((e: any) => e.schedule_id === c.id && !["Dropped", "Waitlisted"].includes(e.status)).length;
    ev("C|" + c.id + "|" + ws, (c.class_name || "Class") + " class (" + n + " kids)", c.day, c.time, minutes(c.duration, 60), [c.coach || "", "FlipLab 3.0"].filter(Boolean).join(" · "));
  });
  return out;
}

async function syncWeek(token: string, cal: string, gym: string, s: any, ws: string) {
  const want = await wantedEvents(gym, s, ws);
  const calP = encodeURIComponent(cal);
  const q = new URLSearchParams({ timeMin: ws + "T00:00:00" + nyOffset(ws), timeMax: addDays(ws, 7) + "T00:00:00" + nyOffset(addDays(ws, 7)),
    privateExtendedProperty: "fl3=1", singleEvents: "true", maxResults: "2500", showDeleted: "false" });
  const have = ((await gcal(token, "GET", `/calendars/${calP}/events?` + q))?.items || []) as any[];
  const byKey = new Map<string, any>(); const n = { added: 0, changed: 0, removed: 0 };
  for (const e of have) {
    const k = e.extendedProperties?.private?.key;
    if (!k || byKey.has(k) || !want.some(w => w.key === k)) { await gcal(token, "DELETE", `/calendars/${calP}/events/${e.id}`); n.removed++; }   // gone or duplicate
    else byKey.set(k, e);
  }
  for (const w of want) {
    const e = byKey.get(w.key);
    if (!e) { await gcal(token, "POST", `/calendars/${calP}/events`, w.body); n.added++; }
    else if (e.extendedProperties?.private?.sig !== (w.body.extendedProperties as any).private.sig) { await gcal(token, "PUT", `/calendars/${calP}/events/${e.id}`, w.body); n.changed++; }
  }
  return n;
}

Deno.serve(async (req) => {
  // Dry run for testing: {"dry": true, "week": "YYYY-MM-DD"} → the events this week would get (nothing sent to Google)
  const b = await req.json().catch(() => ({}));
  if (b.dry) {
    const { data: s } = await db.from("cal_settings").select("*").limit(1).maybeSingle();
    const want = await wantedEvents(s.gym_id, s, b.week);
    return new Response(JSON.stringify(want.map(w => [(w.body.start as any).dateTime, w.body.summary, w.body.colorId || "", w.body.description])), { headers: { "Content-Type": "application/json" } });
  }
  const runStart = new Date().toISOString(), report: string[] = [];
  const { data: queue } = await db.from("cal_queue").select("*").lte("queued_at", runStart).order("week_start");
  const gyms = [...new Set((queue || []).map((q: any) => q.gym_id))];
  for (const gym of gyms) {
    // one run per gym at a time
    const { data: lock } = await db.from("cal_settings").update({ locked_until: new Date(Date.now() + 120000).toISOString() })
      .eq("gym_id", gym).or("locked_until.is.null,locked_until.lt." + new Date().toISOString()).select().maybeSingle();
    if (!lock) { report.push(gym + ": busy"); continue; }
    const weeks = (queue || []).filter((q: any) => q.gym_id === gym).map((q: any) => q.week_start);
    let result = "";
    try {
      const cal = lock.mode === "live" ? lock.live_calendar_id : lock.mode === "test" ? lock.test_calendar_id : null;
      if (lock.mode === "off") result = "Off — nothing synced";
      else if (!cal) result = "No calendar ID set for " + lock.mode + " mode";
      else {
        const token = await googleToken(), tot = { added: 0, changed: 0, removed: 0 };
        for (const ws of weeks) { const r = await syncWeek(token, cal, gym, lock, ws); tot.added += r.added; tot.changed += r.changed; tot.removed += r.removed; }
        result = `✓ ${weeks.length} week${weeks.length === 1 ? "" : "s"} · ${tot.added} added · ${tot.changed} changed · ${tot.removed} removed`;
      }
      await db.from("cal_queue").delete().eq("gym_id", gym).in("week_start", weeks).lte("queued_at", runStart);
    } catch (e) {
      result = "Error: " + (e as Error).message;   // queue kept → retried next minute
    }
    await db.from("cal_settings").update({ locked_until: null, last_run_at: new Date().toISOString(), last_result: result }).eq("gym_id", gym);
    report.push(gym + ": " + result);
  }
  return new Response(JSON.stringify({ ok: true, report }), { headers: { "Content-Type": "application/json" } });
});
