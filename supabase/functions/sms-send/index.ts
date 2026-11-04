// FlipLab 3.0 — send texts through Steve's phone (SMS Gateway for Android, cloud server mode).
// Called by the admin page (signed-in user; verify_jwt on).
//   Send:  { messages: [{ to, text, student_id?, family? }], batch? }  → each text logged to text_log (OUT, status Queued, extra.gid = gateway id, extra.batch)
//   Check: { check: true }  → asks the gateway about OUT texts from the last 3 days still in progress; updates status to Sent / Delivered / Failed
// Secrets: SMSGATE_USER, SMSGATE_PASS (same login 2.0 uses in sms.gs).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const e164 = (p: string) => { const d = String(p || "").replace(/\D/g, ""); return d.length === 10 ? "+1" + d : d.length === 11 && d[0] === "1" ? "+" + d : null; };
const GW = "https://api.sms-gate.app/3rdparty/v1";
const OPEN = ["Queued", "Pending", "Processed", "Sent"];   // not final yet

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: gyms } = await user.from("gyms").select("id").limit(1);           // RLS: only the signed-in owner's gym
  if (!gyms?.length) return json({ error: "Not signed in" }, 401);
  const gym = gyms[0].id;
  const u = Deno.env.get("SMSGATE_USER"), pw = Deno.env.get("SMSGATE_PASS");
  if (!u || !pw) return json({ error: "Texting isn't set up yet (SMSGATE_USER / SMSGATE_PASS secrets missing)" }, 500);
  const auth = { Authorization: "Basic " + btoa(u + ":" + pw) };
  const body = await req.json().catch(() => ({}));
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ---- Check mode: update status of recent texts ----
  if (body.check) {
    const since = new Date(Date.now() - 3 * 864e5).toISOString();
    const { data: rows } = await db.from("text_log").select("id,status,extra").eq("gym_id", gym).eq("direction", "OUT")
      .in("status", OPEN).gte("received_at", since).not("extra->>gid", "is", null).limit(60);
    let changed = 0;
    for (const t of rows || []) {
      const gid = t.extra.gid;
      let r = await fetch(`${GW}/messages/${gid}`, { headers: auth });
      if (r.status === 404) r = await fetch(`${GW}/message/${gid}`, { headers: auth });   // older API path
      if (!r.ok) continue;
      const s = await r.json().catch(() => null);
      const st = s?.state; if (!st || st === t.status) continue;
      const err = st === "Failed" ? (s.reason || (s.recipients || []).map((x: any) => x.error).filter(Boolean).join("; ") || "Failed on phone") : undefined;
      await db.from("text_log").update({ status: st, extra: { ...t.extra, ...(err ? { error: String(err).slice(0, 300) } : {}) } }).eq("id", t.id);
      changed++;
    }
    return json({ checked: (rows || []).length, changed });
  }

  // ---- Send mode ----
  const { messages = [], batch = null } = body;
  const results = [];
  for (const m of messages.slice(0, 60)) {
    const to = e164(m.to);
    if (!to || !m.text) { results.push({ to: m.to, ok: false, error: "Bad phone or empty text" }); continue; }
    const r = await fetch(`${GW}/message`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ textMessage: { text: m.text }, phoneNumbers: [to], withDeliveryReport: true }) });
    const ok = r.ok, txt = await r.text();
    let gid = null; try { gid = JSON.parse(txt).id || null; } catch (_) { /* not JSON */ }
    await db.from("text_log").insert({ gym_id: gym, direction: "OUT", phone: to.slice(-10), student_id: m.student_id || null, family_name: m.family || null,
      body: m.text, status: ok ? "Queued" : "Failed", received_at: new Date().toISOString(),
      extra: ok ? { gid, batch } : { batch, error: txt.slice(0, 300) } });
    results.push({ to: m.to, ok, error: ok ? undefined : txt.slice(0, 200) });
  }
  return json({ sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
});
