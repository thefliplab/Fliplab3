// FlipLab 3.0 — send texts through Steve's phone (SMS Gateway for Android, cloud server mode).
// Called by the admin page (signed-in user; verify_jwt on). Body: { messages: [{ to, text, student_id?, family? }] }
// Secrets: SMSGATE_USER, SMSGATE_PASS (same login 2.0 uses in sms.gs). Each text is logged to text_log (direction OUT).
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const e164 = (p: string) => { const d = String(p || "").replace(/\D/g, ""); return d.length === 10 ? "+1" + d : d.length === 11 && d[0] === "1" ? "+" + d : null; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: gyms } = await user.from("gyms").select("id").limit(1);           // RLS: only the signed-in owner's gym
  if (!gyms?.length) return json({ error: "Not signed in" }, 401);
  const gym = gyms[0].id;
  const u = Deno.env.get("SMSGATE_USER"), pw = Deno.env.get("SMSGATE_PASS");
  if (!u || !pw) return json({ error: "Texting isn't set up yet (SMSGATE_USER / SMSGATE_PASS secrets missing)" }, 500);
  const { messages = [] } = await req.json().catch(() => ({}));
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const results = [];
  for (const m of messages.slice(0, 60)) {
    const to = e164(m.to);
    if (!to || !m.text) { results.push({ to: m.to, ok: false, error: "Bad phone or empty text" }); continue; }
    const r = await fetch("https://api.sms-gate.app/3rdparty/v1/message", { method: "POST",
      headers: { Authorization: "Basic " + btoa(u + ":" + pw), "Content-Type": "application/json" },
      body: JSON.stringify({ textMessage: { text: m.text }, phoneNumbers: [to] }) });
    const ok = r.ok, body = await r.text();
    await db.from("text_log").insert({ gym_id: gym, direction: "OUT", phone: to.slice(-10), student_id: m.student_id || null, family_name: m.family || null,
      body: m.text, status: ok ? "Queued" : "Failed", received_at: new Date().toISOString(), extra: ok ? {} : { error: body.slice(0, 300) } });
    results.push({ to: m.to, ok, error: ok ? undefined : body.slice(0, 200) });
  }
  return json({ sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
});
