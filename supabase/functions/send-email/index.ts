// FlipLab 3.0 — send email. Flip Lab: through Yahoo as "Flip Lab" <thefliplab@yahoo.com>. Other gyms: only through their OWN connected email (email-connect).
// Called by the admin page (signed-in user; verify_jwt on).
//   { messages: [{ to, subject, text, student_id?, family? }], batch? }  → up to 40 per call, ~1.5s apart
//   Each email logged to email_log (status Sent / Failed).
// Secrets: YAHOO_APP_PASSWORD (Yahoo app password "FlipLab 3.0"); YAHOO_USER optional (default thefliplab@yahoo.com).
// Uses port 465 (Supabase blocks 25 and 587).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const okEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toHtml = (t: string) => `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5">${esc(t).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, "<br>")}</div>`;
const HOSTS: Record<string, string> = { gmail: "smtp.gmail.com", yahoo: "smtp.mail.yahoo.com", aol: "smtp.aol.com" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: gyms } = await user.from("gyms").select("id,name,slug").limit(1);           // RLS: only the signed-in owner's gym
  if (!gyms?.length) return json({ error: "Not signed in" }, 401);
  const gym = gyms[0].id;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // Flip Lab → Steve's Yahoo (secrets). Other gyms → only their OWN connected email (email-connect); never Steve's.
  let from = "", pw: string | undefined, host = "smtp.mail.yahoo.com", name = "Flip Lab";
  if (gyms[0].slug === "fliplab") { from = Deno.env.get("YAHOO_USER") || "thefliplab@yahoo.com"; pw = Deno.env.get("YAHOO_APP_PASSWORD"); }
  else {
    const { data: cr } = await db.rpc("gym_email_get", { p_gym: gym });
    const c = (cr || [])[0];
    if (!c) return json({ error: "Connect your email in Settings first" }, 403);
    from = c.address; pw = c.pw; host = HOSTS[c.provider] || ""; name = gyms[0].name;
  }
  if (!pw || !host) return json({ error: "Email isn't set up yet" }, 500);
  const { messages = [], batch = null } = await req.json().catch(() => ({}));

  let client: SMTPClient;
  try {
    client = new SMTPClient({ connection: { hostname: host, port: 465, tls: true, auth: { username: from, password: pw } } });
  } catch (e) { return json({ error: "Couldn't connect to email: " + String(e).slice(0, 200) }, 500); }

  const results = [];
  for (const [i, m] of messages.slice(0, 40).entries()) {
    const to = String(m.to || "").trim();
    let ok = false, error: string | undefined;
    if (!okEmail(to) || !m.text) error = "Bad email address or empty message";
    else {
      try {
        if (i > 0) await sleep(1500);   // go easy on the mail server
        await client.send({ from: `${name} <${from}>`, to, subject: m.subject || name, content: m.text, html: toHtml(m.text) });
        ok = true;
      } catch (e) { error = String((e as Error)?.message || e).slice(0, 300); }
    }
    await db.from("email_log").insert({ gym_id: gym, to_email: to || "(none)", student_id: m.student_id || null, family_name: m.family || null,
      subject: m.subject || name, body: m.text || "", status: ok ? "Sent" : "Failed", error: error || null, batch });
    results.push({ to, ok, error });
  }
  try { await client.close(); } catch (_) { /* already closed */ }
  return json({ sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
});
