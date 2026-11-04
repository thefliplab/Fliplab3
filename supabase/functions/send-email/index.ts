// FlipLab 3.0 — send email through Yahoo as "Flip Lab" <thefliplab@yahoo.com> (no Apps Script / 2.0 needed).
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: gyms } = await user.from("gyms").select("id,slug").limit(1);           // RLS: only the signed-in owner's gym
  if (!gyms?.length) return json({ error: "Not signed in" }, 401);
  if (gyms[0].slug !== "fliplab") return json({ error: "Automatic texts and emails are not set up for this gym yet" }, 403);   // Steve's phone/Yahoo/Voice are Flip Lab only
  const gym = gyms[0].id;
  const from = Deno.env.get("YAHOO_USER") || "thefliplab@yahoo.com", pw = Deno.env.get("YAHOO_APP_PASSWORD");
  if (!pw) return json({ error: "Email isn't set up yet (YAHOO_APP_PASSWORD secret missing)" }, 500);
  const { messages = [], batch = null } = await req.json().catch(() => ({}));
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let client: SMTPClient;
  try {
    client = new SMTPClient({ connection: { hostname: "smtp.mail.yahoo.com", port: 465, tls: true, auth: { username: from, password: pw } } });
  } catch (e) { return json({ error: "Couldn't connect to Yahoo: " + String(e).slice(0, 200) }, 500); }

  const results = [];
  for (const [i, m] of messages.slice(0, 40).entries()) {
    const to = String(m.to || "").trim();
    let ok = false, error: string | undefined;
    if (!okEmail(to) || !m.text) error = "Bad email address or empty message";
    else {
      try {
        if (i > 0) await sleep(1500);   // go easy on Yahoo
        await client.send({ from: `Flip Lab <${from}>`, to, subject: m.subject || "Flip Lab", content: m.text, html: toHtml(m.text) });
        ok = true;
      } catch (e) { error = String((e as Error)?.message || e).slice(0, 300); }
    }
    await db.from("email_log").insert({ gym_id: gym, to_email: to || "(none)", student_id: m.student_id || null, family_name: m.family || null,
      subject: m.subject || "Flip Lab", body: m.text || "", status: ok ? "Sent" : "Failed", error: error || null, batch });
    results.push({ to, ok, error });
  }
  try { await client.close(); } catch (_) { /* already closed */ }
  return json({ sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
});
