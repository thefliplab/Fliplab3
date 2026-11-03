// FlipLab 3.0 — after a family signs up on register.html: confirmation email to the parent, email + text to the coach.
// No login (public page). Safe: only students created in the last 15 minutes by the sign-up page, once each (extra.Notified).
// Secrets: YAHOO_APP_PASSWORD (email from "Flip Lab" <thefliplab@yahoo.com>), SMSGATE_USER / SMSGATE_PASS (coach text).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
const FROM = "thefliplab@yahoo.com", ZELLE = "951-317-5158", VENMO = "https://venmo.com/code?user_id=2634245503713280412";
const txt = (h: string) => h.replace(/<br>|<\/p>/g, "\n").replace(/<[^>]+>/g, "").replace(/\n\s+/g, "\n").trim();
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const { ids = [], what = "", shareType = "" } = await req.json().catch(() => ({}));
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const since = new Date(Date.now() - 15 * 60e3).toISOString();
  const { data: kids } = await db.from("students").select("id,gym_id,first_name,last_name,skill_level,parent_name,parent_phone,parent_email,extra")
    .in("id", (ids as string[]).slice(0, 2)).gte("created_at", since).eq("extra->>Source", "3.0 sign-up").is("extra->>Notified", null);
  if (!kids?.length) return json({ ok: true, skipped: true });
  for (const k of kids) await db.from("students").update({ extra: { ...k.extra, Notified: new Date().toISOString(), ...(shareType ? { ShareType: String(shareType).slice(0, 30) } : {}) } }).eq("id", k.id);

  const k = kids[0], names = kids.map((x) => x.first_name + " " + x.last_name).join(" & ");
  const first = kids.map((x) => x.first_name).join(" & "), parentFirst = String(k.parent_name || "").split(" ")[0];
  const pay = k.extra?.PaymentMethod || "";
  const lines = [`<b>Athlete:</b> ${esc(names)}`, `<b>Parent:</b> ${esc(k.parent_name)} · ${esc(k.parent_phone)} · ${esc(k.parent_email)}`,
    `<b>Signed up for:</b> ${esc(what)}`, pay ? `<b>Payment:</b> ${esc(pay)}` : "", shareType && shareType !== "Solo" ? `<b>Sharing:</b> ${esc(shareType)}${k.extra?.FriendName ? " (" + esc(k.extra.FriendName) + ")" : ""}` : ""].filter(Boolean).join("<br>");
  const payHtml = pay === "Zelle" ? `Zelle: <b>${ZELLE}</b>` : pay === "Venmo" ? `<a href="${VENMO}">Pay with Venmo</a>` : "Cash at the lesson";
  const isWait = /waitlist/i.test(what);
  const parentHtml = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#222;line-height:1.6">
    <p>Hi ${esc(parentFirst)}!</p>
    <p>${isWait ? `Thanks for signing up ${esc(first)}. You're on the Flip Lab waitlist, and I'll reach out as soon as a spot opens that fits your times.`
      : `Thanks for signing up ${esc(first)}! You're all set: <b>${esc(what)}</b>.`}</p>
    ${isWait ? "" : `<p>Payment is due at each lesson: ${payHtml}. Please include the athlete's name and lesson date in the payment note.</p>`}
    <p>Questions? Just reply to this email or text me.</p><p>Coach Steve<br>Flip Lab</p></div>`;

  const pw = Deno.env.get("YAHOO_APP_PASSWORD");
  const out: Record<string, unknown> = {};
  if (pw) {
    try {
      const client = new SMTPClient({ connection: { hostname: "smtp.mail.yahoo.com", port: 465, tls: true, auth: { username: FROM, password: pw } } });
      if (k.parent_email) await client.send({ from: `Flip Lab <${FROM}>`, to: k.parent_email, replyTo: FROM, subject: isWait ? "You're on the Flip Lab waitlist" : "Welcome to Flip Lab!", html: parentHtml, content: txt(parentHtml) });
      await client.send({ from: `Flip Lab <${FROM}>`, to: FROM, subject: `New sign-up: ${names}`, html: `<div style="font-family:Arial,sans-serif;font-size:14px">${lines}</div>`, content: txt(lines) });
      await client.close();
      out.email = true;
    } catch (e) { out.email = String((e as Error).message || e).slice(0, 200); }
  }
  // text the main coach (coach whose email = gym login)
  const { data: co } = await db.from("coaches").select("phone").eq("gym_id", k.gym_id).eq("email", FROM).maybeSingle();
  const d = String(co?.phone || "").replace(/\D/g, ""), to = d.length === 10 ? "+1" + d : null;
  const u = Deno.env.get("SMSGATE_USER"), sp = Deno.env.get("SMSGATE_PASS");
  // Coach text is OFF until Steve turns it on (Nov 3): set secret SIGNUP_TEXT_COACH = on
  if (to && u && sp && Deno.env.get("SIGNUP_TEXT_COACH") === "on") {
    const r = await fetch("https://api.sms-gate.app/3rdparty/v1/message", { method: "POST", headers: { Authorization: "Basic " + btoa(u + ":" + sp), "Content-Type": "application/json" },
      body: JSON.stringify({ textMessage: { text: `FlipLab sign-up: ${names} — ${what}. Parent ${k.parent_name} ${k.parent_phone}` }, phoneNumbers: [to] }) });
    out.text = r.ok;
  }
  return json({ ok: true, ...out });
});
