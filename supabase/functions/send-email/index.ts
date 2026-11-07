// FlipLab 3.0 — send email. Flip Lab: through Yahoo as "Flip Lab" <thefliplab@yahoo.com>. Other gyms: only through their OWN connected email (email-connect).
// Called by the admin page (signed-in user; verify_jwt on).
//   { messages: [{ to, subject, text, student_id?, family? }], batch? }  → up to 40 per call, ~2s apart, fresh connection every 8; one 30s retry, then the rest are marked paused
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

  // Yahoo cuts a connection off after ~10 emails, so open a fresh connection every 8 (same as before).
  // If the server drops us / refuses login: wait 30s, try ONCE more; still no → stop and mark the rest "paused" (don't hammer it).
  const connect = () => new SMTPClient({ connection: { hostname: host, port: 465, tls: true, auth: { username: from, password: pw! } } });
  const close = async (c: SMTPClient | null) => { try { await c?.close(); } catch (_) { /* already closed */ } };
  let client: SMTPClient | null = null, onThis = 0, retried = false, paused = false;
  const sendOne = async (mail: Record<string, string>) => {
    if (!client || onThis >= 8) { await close(client); if (client) await sleep(3000); client = connect(); onThis = 0; }
    onThis++;
    await client.send(mail as never);
  };
  const errOf = (e: unknown) => String((e as Error)?.message || e).slice(0, 300);

  const results = [];
  for (const [i, m] of messages.slice(0, 40).entries()) {
    const to = String(m.to || "").trim();
    let ok = false, error: string | undefined;
    const mail = { from: `${name} <${from}>`, to, subject: m.subject || name, content: m.text, html: toHtml(m.text || "") };
    if (!okEmail(to) || !m.text) error = "Bad email address or empty message";
    else if (paused) error = "Mail server paused sending. Resend in 30 min.";
    else {
      if (i > 0) await sleep(2000);   // go easy on the mail server
      try { await sendOne(mail); ok = true; }
      catch (e) {
        error = errOf(e);
        if (!retried) {
          retried = true; await close(client); client = null; await sleep(30000);
          try { await sendOne(mail); ok = true; error = undefined; }
          catch (e2) { error = errOf(e2); paused = true; }
        } else paused = true;
      }
    }
    await db.from("email_log").insert({ gym_id: gym, to_email: to || "(none)", student_id: m.student_id || null, family_name: m.family || null,
      subject: m.subject || name, body: m.text || "", status: ok ? "Sent" : "Failed", error: error || null, batch });
    results.push({ to, ok, error, family: m.family || null });
  }
  await close(client);
  return json({ sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
});
