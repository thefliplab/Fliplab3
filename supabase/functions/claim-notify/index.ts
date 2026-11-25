// FlipLab 3.0 — tell the coach when a family claims an opening (called by claim_take() in the database).
// Only ever sends one fixed alert per won claim (notified flag), so it is safe without a login.
// v8 (Nov 25): Flip Lab alert = text to Steve's 513 phone (the 234 phone is the SMSGate sender, so texting it never arrived) + email to thefliplab@yahoo.com.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const ALERT_TEXT_TO = "+15134432674";
const ALERT_EMAIL_TO = "thefliplab@yahoo.com";

Deno.serve(async (req) => {
  const { token } = await req.json().catch(() => ({}));
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: c } = await db.from("claim_links").update({ notified: true }).eq("token", token || "").eq("status", "won").eq("notified", false).select().maybeSingle();
  if (!c) return new Response(JSON.stringify({ ok: true, skipped: true }));
  const { data: g } = await db.from("gyms").select("slug").eq("id", c.gym_id).maybeSingle();   // alerts go out from Steve's phone / Yahoo → Flip Lab only
  if (g?.slug !== "fliplab") return new Response(JSON.stringify({ ok: true, skipped: "not Flip Lab" }));
  const date = new Date(c.slot_date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const msg = `FlipLab: ${c.student_name} claimed ${c.day.slice(0, 3)} ${date} ${c.time} (this week only).`;
  const out: Record<string, unknown> = {};

  // 1) Text to Steve's 513 phone
  const u = Deno.env.get("SMSGATE_USER"), pw = Deno.env.get("SMSGATE_PASS");
  if (u && pw) {
    try {
      const r = await fetch("https://api.sms-gate.app/3rdparty/v1/message", { method: "POST",
        headers: { Authorization: "Basic " + btoa(u + ":" + pw), "Content-Type": "application/json" },
        body: JSON.stringify({ textMessage: { text: msg }, phoneNumbers: [ALERT_TEXT_TO] }) });
      out.text = r.ok;
    } catch (e) { out.text = false; out.textError = String((e as Error)?.message || e).slice(0, 200); }
  } else out.text = "texting not set up";

  // 2) Email to thefliplab@yahoo.com
  const from = Deno.env.get("YAHOO_USER") || "thefliplab@yahoo.com", ypw = Deno.env.get("YAHOO_APP_PASSWORD");
  const subject = `Spot claimed: ${c.student_name} ${c.day.slice(0, 3)} ${date} ${c.time}`;
  let ok = false, error: string | null = null;
  if (ypw) {
    const client = new SMTPClient({ connection: { hostname: "smtp.mail.yahoo.com", port: 465, tls: true, auth: { username: from, password: ypw } } });
    try { await client.send({ from: `Flip Lab <${from}>`, to: ALERT_EMAIL_TO, subject, content: msg } as never); ok = true; }
    catch (e) { error = String((e as Error)?.message || e).slice(0, 300); }
    try { await client.close(); } catch (_) { /* closed */ }
  } else error = "Email isn't set up";
  out.email = ok;
  await db.from("email_log").insert({ gym_id: c.gym_id, to_email: ALERT_EMAIL_TO, student_id: c.student_id || null, family_name: null,
    subject, body: msg, status: ok ? "Sent" : "Failed", error, batch: "claim-alert" });

  return new Response(JSON.stringify({ ok: true, ...out }));
});
