// FlipLab 3.0 — send email. Flip Lab: through Yahoo as "Flip Lab" <thefliplab@yahoo.com>. Other gyms: only through their OWN connected email (email-connect).
// Called by the admin page (signed-in user; verify_jwt on).
//   { messages: [{ to, subject, text, student_id?, family? }], batch? }  → up to 40 per call (the page sends 8 at a time), ~3s apart
//   Each email logged to email_log (status Sent / Failed).
//   If the mail server refuses one or drops the connection, it reconnects, tries that email once more, and keeps going.
//   Every send has a time limit, so one stuck email can never freeze the whole batch.
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
const GAP_MS = 3000;          // pause between emails (go easy on the mail server)
const SEND_LIMIT_MS = 25000;  // give up on one email after 25s
const STOP_AFTER_MS = 110000; // don't start new emails after ~2 min; the rest come back as "not tried" so the page can resend

function withLimit<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("Timed out talking to the mail server")), ms))]);
}

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

  const connect = () => new SMTPClient({ connection: { hostname: host, port: 465, tls: true, auth: { username: from, password: pw! } } });
  const drop = async (c: SMTPClient | null) => { if (c) { try { await withLimit(c.close(), 3000); } catch (_) { /* already closed */ } } };
  let client: SMTPClient | null = null;

  const started = Date.now();
  const results: { to: string; ok: boolean; error?: string; notTried?: boolean }[] = [];
  const list = messages.slice(0, 40);
  for (const [i, m] of list.entries()) {
    const to = String(m.to || "").trim();
    if (Date.now() - started > STOP_AFTER_MS) { results.push({ to, ok: false, notTried: true, error: "Not tried (ran out of time)" }); continue; }
    let ok = false, error: string | undefined;
    if (!okEmail(to) || !m.text) error = "Bad email address or empty message";
    else {
      if (i > 0) await sleep(GAP_MS);
      const mail = { from: `${name} <${from}>`, to, subject: m.subject || name, content: m.text, html: toHtml(m.text) };
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        try {
          if (!client) client = connect();
          await withLimit(client.send(mail), SEND_LIMIT_MS);
          ok = true; error = undefined;
        } catch (e) {
          error = String((e as Error)?.message || e).slice(0, 300);
          await drop(client); client = null;          // that connection is dead — start fresh
          if (attempt === 1) await sleep(5000);       // short pause, then one more try
        }
      }
    }
    await db.from("email_log").insert({ gym_id: gym, to_email: to || "(none)", student_id: m.student_id || null, family_name: m.family || null,
      subject: m.subject || name, body: m.text || "", status: ok ? "Sent" : "Failed", error: error || null, batch });
    results.push({ to, ok, error });
  }
  await drop(client);
  return json({ sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
});
