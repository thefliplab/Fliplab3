// FlipLab 3.0 — incoming texts. SMS Gateway for Android (cloud) calls this webhook on sms:received.
// URL: /functions/v1/sms-receive?k=<gym_secrets.sms_rx_key>   (verify_jwt off; the key picks the gym)
// MacroDroid (Nov 3): same URL, fields from / msg / app — catches RCS + Google Voice notifications.
// Only texts from a phone that matches a student/waitlist parent are saved (Steve, Nov 2) → text_log IN, status Unread.
// Setup:  ?k=..&register=1  → registers this URL as the gateway's sms:received webhook (replaces old ones).
// Deployed copy is the source of truth; the key lives only in table gym_secrets (not in this repo).
import { createClient } from "jsr:@supabase/supabase-js@2";

const GW = "https://api.sms-gate.app/3rdparty/v1";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const d10 = (p: string) => String(p || "").replace(/\D/g, "").slice(-10);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const k = url.searchParams.get("k") || url.searchParams.get("smskey") || "";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (!k) return json({ error: "no key" }, 403);
  const { data: sec } = await db.from("gym_secrets").select("gym_id").eq("sms_rx_key", k).maybeSingle();
  if (!sec) return json({ error: "bad key" }, 403);
  const gym = sec.gym_id;

  // ---- Register webhook with the gateway ----
  if (url.searchParams.get("register")) {
    const u = Deno.env.get("SMSGATE_USER"), pw = Deno.env.get("SMSGATE_PASS");
    const auth = { Authorization: "Basic " + btoa(u + ":" + pw) };
    const me = `${Deno.env.get("SUPABASE_URL")}/functions/v1/sms-receive?k=${k}`;
    const list = await (await fetch(`${GW}/webhooks`, { headers: auth })).json().catch(() => []);
    for (const w of Array.isArray(list) ? list : []) {
      if (w.event === "sms:received" && String(w.url || "").includes("/functions/v1/sms-receive")) await fetch(`${GW}/webhooks/${w.id}`, { method: "DELETE", headers: auth });
    }
    const r = await fetch(`${GW}/webhooks`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ url: me, event: "sms:received" }) });
    return json({ ok: r.ok, status: r.status, gateway: await r.text() });
  }

  // ---- Incoming text ----
  // Two senders: SMSGate webhook (JSON {event, payload}) or MacroDroid (from / msg / app as query, form or JSON — reads phone
  // notifications, so it works with RCS chat and Google Voice; same fields 2.0's sms.gs uses).
  let b: any = {};
  const ct = req.headers.get("content-type") || "";
  if (req.method === "POST") b = ct.includes("json") ? await req.json().catch(() => ({})) : Object.fromEntries(new URLSearchParams(await req.text().catch(() => "")));
  const q = (n: string) => String(b[n] ?? url.searchParams.get(n) ?? "").trim();
  const md = !b.event && !b.payload;                 // MacroDroid
  const none = md ? new Response("", { status: 200 }) : null;   // MacroDroid shows nothing
  const done = (o: unknown) => none || json(o);
  if (b.event && b.event !== "sms:received") return json({ ignored: b.event });
  const p = b.payload || {};
  const from = md ? q("from") : String(p.phoneNumber || p.sender || "");
  const text = md ? q("msg") : String(p.message ?? p.text ?? p.textMessage?.text ?? "");
  const line = md && /voice/i.test(q("app")) ? "Voice" : "Cell";
  const gmid = md ? null : (p.messageId || b.id || null);
  if (!from || !text) return done({ skipped: "no sender/text" });

  // who sent it: a number, or (MacroDroid) a contact name matched to a parent name
  const nrm = (x: string) => String(x || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  let phone = /[a-z]/i.test(from) ? "" : d10(from);
  let kids: any[] = [], wl: any[] = [];
  const S = "id,first_name,last_name,parent_name,parent_phone,status", W = "id,student_id,student_name,parent_name,parent_phone";
  if (phone.length === 10) {
    const last4 = phone.slice(-4);
    const { data: st } = await db.from("students").select(S).eq("gym_id", gym).ilike("parent_phone", `%${last4}`);
    kids = (st || []).filter((s) => d10(s.parent_phone) === phone);
    if (!kids.length) {
      const { data: w } = await db.from("waitlist").select(W).eq("gym_id", gym).ilike("parent_phone", `%${last4}`);
      wl = (w || []).filter((x) => d10(x.parent_phone) === phone);
    }
  } else {
    const n = nrm(from), parts = n.split(" ");
    const same = (pn: string) => { const m = nrm(pn); if (!m) return false; if (m === n) return true;
      const mp = m.split(" "); return parts.length > 1 && mp.length > 1 && mp[0] === parts[0] && mp[mp.length - 1] === parts[parts.length - 1]; };
    const { data: st } = await db.from("students").select(S).eq("gym_id", gym).not("parent_name", "is", null).range(0, 1999);
    kids = (st || []).filter((s) => same(s.parent_name) && d10(s.parent_phone).length === 10);
    if (!kids.length) {
      const { data: w } = await db.from("waitlist").select(W).eq("gym_id", gym).not("parent_name", "is", null).range(0, 1999);
      wl = (w || []).filter((x) => same(x.parent_name) && d10(x.parent_phone).length === 10);
    }
    phone = d10((kids[0] || wl[0] || {}).parent_phone || "");
    kids = kids.filter((s) => d10(s.parent_phone) === phone); wl = wl.filter((x) => d10(x.parent_phone) === phone);
  }
  if (!kids.length && !wl.length) return done({ skipped: "not a parent" });

  {   // notifications repeat, and SMSGate + MacroDroid can both report one SMS — skip same text from same family within 5 min
    const { data: dup } = await db.from("text_log").select("id").eq("gym_id", gym).eq("direction", "IN").eq("phone", phone).eq("body", text.slice(0, 2000))
      .gte("received_at", new Date(Date.now() - 5 * 60e3).toISOString()).limit(1);
    if (dup?.length) return done({ dup: true });
  }
  if (gmid) {   // gateway can retry — don't save twice
    const { data: dup } = await db.from("text_log").select("id").eq("gym_id", gym).eq("direction", "IN").eq("extra->>gmid", gmid).limit(1);
    if (dup?.length) return json({ dup: true });
  }
  kids.sort((a, c) => (a.status === "Active" ? 0 : 1) - (c.status === "Active" ? 0 : 1));
  const first = kids[0];
  const row = {
    gym_id: gym, direction: "IN", phone, body: String(text).slice(0, 2000), status: "Unread",
    student_id: first ? first.id : (wl[0].student_id || null),
    family_name: first ? first.parent_name : wl[0].parent_name,
    received_at: !md && p.receivedAt ? new Date(p.receivedAt).toISOString() : new Date().toISOString(),
    extra: { gmid, line, via: md ? "MacroDroid" : "SMSGate", from: md ? from.slice(0, 80) : undefined, kids: kids.length ? kids.map((s) => s.first_name) : wl.map((x) => x.student_name), waitlist: !kids.length ? wl.map((x) => x.id) : undefined },
  };
  const { error } = await db.from("text_log").insert(row);
  return done(error ? { error: error.message } : { saved: true });
});
