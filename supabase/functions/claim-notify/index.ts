// FlipLab 3.0 — tell the coach when a family claims an opening (called by claim_take() in the database).
// Only ever sends one fixed text per won claim (notified flag), so it is safe without a login.
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const { token } = await req.json().catch(() => ({}));
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: c } = await db.from("claim_links").update({ notified: true }).eq("token", token || "").eq("status", "won").eq("notified", false).select().maybeSingle();
  if (!c) return new Response(JSON.stringify({ ok: true, skipped: true }));
  const d = String(c.alert_phone || "").replace(/\D/g, ""), to = d.length === 10 ? "+1" + d : d.length === 11 ? "+" + d : null;
  const u = Deno.env.get("SMSGATE_USER"), pw = Deno.env.get("SMSGATE_PASS");
  if (!to || !u || !pw) return new Response(JSON.stringify({ ok: false, error: "no alert phone or texting not set up" }));
  const date = new Date(c.slot_date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const text = `FlipLab: ${c.student_name} claimed ${c.day.slice(0, 3)} ${date} ${c.time} (this week only).`;
  const r = await fetch("https://api.sms-gate.app/3rdparty/v1/message", { method: "POST",
    headers: { Authorization: "Basic " + btoa(u + ":" + pw), "Content-Type": "application/json" },
    body: JSON.stringify({ textMessage: { text }, phoneNumbers: [to] }) });
  return new Response(JSON.stringify({ ok: r.ok }));
});
