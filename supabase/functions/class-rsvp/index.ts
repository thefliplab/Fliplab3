// FlipLab 3.0 — Friday RSVP email for Sunday classes (copy of 2.0 sendSundayRsvpBlast).
// verify_jwt OFF:
//   { cron: true }  ← pg_cron Fridays 12:00 + 13:00 UTC. Only sends when it's Friday 8 AM in New York, the
//                     gym's switch (gym_settings 'rsvp_friday' {on}) is ON, and it hasn't already sent this week.
//   { test: true }  ← signed-in admin ("Send me a test"): one sample email to the gym's Yahoo address only.
// Who gets it: kids enrolled (not Dropped/Waitlisted) in active weekly Sunday classes, with no answer yet this week.
// Each kid gets a class_rsvp row (week_start = Monday) with a token; the buttons open <site_url>rsvp.html?t=..&a=yes|no.
// Sends through Yahoo (same as send-email), logs email_log, then emails Steve a short summary.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const okEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());
const esc = (s: string) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BRAND = "#4349C6", COACH = "Coach Steve";

// New York calendar date/time parts
function ny() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, wd: p.weekday };
}
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const mondayOf = (ymd: string) => { const d = new Date(ymd + "T12:00:00Z"), w = d.getUTCDay(); return addDays(ymd, w === 0 ? -6 : 1 - w); };
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, "0")).join("");

function emailHtml(gym: string, parentFirst: string, first: string, sunLabel: string, time: string, yes: string, no: string, portal: string) {
  return `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">`
    + `<div style="background:${BRAND};padding:20px;text-align:center"><h1 style="color:white;letter-spacing:3px;margin:0;font-size:22px">${esc(gym.toUpperCase())}</h1></div>`
    + `<div style="padding:24px;color:#2c2c2a;line-height:1.7">`
    + `<p>Hi ${esc(parentFirst)},</p>`
    + `<p style="margin-top:10px">Will <strong>${esc(first)}</strong> be at Sunday's class on <strong>${esc(sunLabel)}</strong> at ${esc(time)}?</p>`
    + `<div style="text-align:center;margin:24px 0">`
    + `<a href="${yes}" style="display:inline-block;background:#3B6D11;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px;margin:6px">Yes, we'll be there!</a>`
    + `<a href="${no}" style="display:inline-block;background:#A32D2D;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px;margin:6px">Can't make it</a>`
    + `</div><p style="font-size:13px;color:#888">Please reply by Saturday so we know who to expect.</p>`
    + `<p style="font-size:13px;color:#888;margin-top:4px">Or <a href="${portal}" style="color:#888">reply in your parent portal</a></p>`
    + `<p style="color:${BRAND};font-weight:bold;margin-top:16px">— ${COACH} &amp; The ${esc(gym)} Team</p></div></div>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const from = Deno.env.get("YAHOO_USER") || "thefliplab@yahoo.com", pw = Deno.env.get("YAHOO_APP_PASSWORD");
  if (!pw) return json({ error: "Email isn't set up (YAHOO_APP_PASSWORD missing)" }, 500);
  const now = ny(), ws = mondayOf(now.ymd), sun = addDays(ws, 6), sunLabel = `${+sun.slice(5, 7)}/${+sun.slice(8, 10)}`;

  // Which gyms
  let gyms: { id: string; name: string }[] = [];
  if (body.test) {
    const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
    const { data } = await user.from("gyms").select("id,name,slug").limit(1);   // RLS: signed-in owner only
    if (!data?.length) return json({ error: "Not signed in" }, 401);
    if (data[0].slug !== "fliplab") return json({ error: "Automatic emails are not set up for this gym yet" }, 403);
    gyms = data;
  } else if (body.cron) {
    if (now.wd !== "Fri" || now.hour !== 8) return json({ skipped: "not Friday 8 AM in New York" });
    const { data } = await db.from("gyms").select("id,name").eq("slug", "fliplab");   // sends from Steve's Yahoo → Flip Lab only
    gyms = data || [];
  } else return json({ error: "Nothing to do" }, 400);

  let client: SMTPClient;
  try { client = new SMTPClient({ connection: { hostname: "smtp.mail.yahoo.com", port: 465, tls: true, auth: { username: from, password: pw } } }); }
  catch (e) { return json({ error: "Couldn't connect to Yahoo: " + String(e).slice(0, 200) }, 500); }
  const send = async (to: string, subject: string, html: string, text: string) => client.send({ from: `Flip Lab <${from}>`, to, subject, content: text, html });

  const out: Record<string, unknown>[] = [];
  for (const g of gyms) {
    const { data: S } = await db.from("gym_settings").select("key,value").eq("gym_id", g.id).in("key", ["rsvp_friday", "site_url"]);
    const set = Object.fromEntries((S || []).map((x) => [x.key, x.value]));
    const sw = set.rsvp_friday || {}, site = String(set.site_url || "https://deploy-preview-1--fliplab3-admin.netlify.app/").replace(/\/?$/, "/");
    if (body.cron && (!sw.on || sw.last_week === ws)) { out.push({ gym: g.name, skipped: !sw.on ? "switch OFF" : "already sent this week" }); continue; }

    const { data: C } = await db.from("class_schedule").select("id,class_name,time").eq("gym_id", g.id).eq("active", true).eq("kind", "weekly").eq("day", "Sunday");
    if (body.test) {
      const c = (C || [])[0] || { class_name: "Sunday class", time: "10:30 AM" };
      try {
        await send(from, `[TEST] Is Zoey coming Sunday ${sunLabel}?`, emailHtml(g.name, "Steve", "Zoey", sunLabel, c.time, site + "rsvp.html?t=TEST&a=yes", site + "rsvp.html?t=TEST&a=no", site + "portal.html"),
          `TEST — this is what families get on Friday.\nWill Zoey be at Sunday's class on ${sunLabel} at ${c.time}?`);
        out.push({ gym: g.name, test: true, to: from });
      } catch (e) { out.push({ gym: g.name, error: String((e as Error)?.message || e).slice(0, 300) }); }
      continue;
    }
    if (body.cron) await db.from("gym_settings").upsert({ gym_id: g.id, key: "rsvp_friday", value: { ...sw, last_week: ws }, updated_at: new Date().toISOString() });

    const ids = (C || []).map((c) => c.id);
    const [{ data: E }, { data: R }] = await Promise.all([
      ids.length ? db.from("class_enrollments").select("schedule_id,student_id,student_name,email,parent_name,status").in("schedule_id", ids) : Promise.resolve({ data: [] as any[] }),
      ids.length ? db.from("class_rsvp").select("*").in("schedule_id", ids).eq("week_start", ws) : Promise.resolve({ data: [] as any[] }),
    ]);
    const kids = (E || []).filter((e) => e.status !== "Dropped" && e.status !== "Waitlisted");
    const sids = [...new Set(kids.map((k) => k.student_id))];
    const { data: ST } = sids.length ? await db.from("students").select("id,first_name,last_name,parent_name,parent_email,unsubscribed").in("id", sids) : { data: [] as any[] };
    const stu = Object.fromEntries((ST || []).map((s) => [s.id, s]));
    let sent = 0, failed = 0; const skipped: string[] = [], batch = crypto.randomUUID();
    for (const k of kids) {
      const s = stu[k.student_id] || {}, c = (C || []).find((x) => x.id === k.schedule_id)!;
      const name = ((s.first_name || "") + " " + (s.last_name || "")).trim() || k.student_name || "";
      const first = s.first_name || name.split(" ")[0] || "your athlete";
      const cur = (R || []).find((r) => r.schedule_id === k.schedule_id && r.student_id === k.student_id);
      if (cur?.answer) { skipped.push(name + " (already answered)"); continue; }
      const to = String(s.parent_email || k.email || "").trim();
      if (!okEmail(to)) { skipped.push(name + " (no email)"); continue; }
      const t = cur?.token || token();
      const up = await db.from("class_rsvp").upsert({ gym_id: g.id, schedule_id: k.schedule_id, student_id: k.student_id, student_name: name, week_start: ws, token: t,
        once: cur?.once || false, source: cur?.source || "admin", answer: cur?.answer || null }, { onConflict: "gym_id,schedule_id,student_id,week_start" });
      if (up.error) { failed++; skipped.push(name + " (" + up.error.message + ")"); continue; }
      const parentFirst = String(s.parent_name || k.parent_name || "").split(" ")[0] || "there";
      const subject = `Is ${first} coming Sunday ${sunLabel}?`;
      let ok = false, error: string | null = null;
      try {
        if (sent + failed > 0) await sleep(1500);
        await send(to, subject, emailHtml(g.name, parentFirst, first, sunLabel, c.time, `${site}rsvp.html?t=${t}&a=yes`, `${site}rsvp.html?t=${t}&a=no`, `${site}portal.html`),
          `Hi ${parentFirst},\nWill ${first} be at Sunday's class on ${sunLabel} at ${c.time}?\nYes: ${site}rsvp.html?t=${t}&a=yes\nCan't make it: ${site}rsvp.html?t=${t}&a=no\nOr reply in your parent portal: ${site}portal.html`);
        ok = true; sent++;
      } catch (e) { failed++; error = String((e as Error)?.message || e).slice(0, 300); }
      await db.from("email_log").insert({ gym_id: g.id, to_email: to, student_id: k.student_id, family_name: name, subject, body: "Friday RSVP email", status: ok ? "Sent" : "Failed", error, batch });
    }
    try {
      await sleep(1500);
      await send(from, `Friday RSVP email: ${sent} sent${failed ? `, ${failed} failed` : ""}`, `<div style="font-family:Arial,sans-serif;font-size:15px">Sunday ${sunLabel}: <b>${sent}</b> sent${failed ? `, <b>${failed}</b> failed` : ""}.${skipped.length ? "<br><br>Skipped:<br>" + skipped.map(esc).join("<br>") : ""}</div>`,
        `Sunday ${sunLabel}: ${sent} sent${failed ? `, ${failed} failed` : ""}.${skipped.length ? "\nSkipped:\n" + skipped.join("\n") : ""}`);
    } catch (_) { /* summary is best-effort */ }
    out.push({ gym: g.name, sent, failed, skipped });
  }
  try { await client.close(); } catch (_) { /* closed */ }
  return json({ ok: true, week: ws, out });
});
