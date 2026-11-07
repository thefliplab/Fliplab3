// FlipLab 3.0 — Parent portal login (verify_jwt OFF; this function checks everything itself).
// Parents log in with phone + their own 4–6 digit code. First time / forgot code: a one-time 6-digit code is texted
// (Flip Lab: SMSGate, Steve's cell. Other gyms: emailed from the gym's OWN connected email to the parent email on file;
// coaches can also make a code on the Student page → RPC portal_make_code), then they pick their own code.
//   { action: 'check',     gym, phone }              → { found, has_pin }
//   { action: 'send_code', gym, phone }              → { ok }            (max 3 per hour per phone, expires 10 min)
//   { action: 'verify',    gym, phone, code }        → { token }         (5 tries per code)
//   { action: 'set_pin',   gym, phone, token, pin }  → { session }
//   { action: 'login',     gym, phone, pin }         → { session }       (5 wrong → locked 15 min)
// Tables parent_accounts / portal_codes: RLS on, no policies (service role only).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const p10 = (p: unknown) => String(p || "").replace(/\D/g, "").slice(-10);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const sha = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const rand = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)).buffer);
const HOSTS: Record<string, string> = { gmail: "smtp.gmail.com", yahoo: "smtp.mail.yahoo.com", aol: "smtp.aol.com" };
const mask = (e: string) => e.replace(/^(.)[^@]*(@.*)$/, "$1***$2");
const URL_ = Deno.env.get("SUPABASE_URL")!, SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

async function pbkdf2(pin: string, salt: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 100000, hash: "SHA-256" }, k, 256));
}
const hashPin = async (pin: string) => { const s = rand(16); return `pbkdf2$${s}$${await pbkdf2(pin, s)}`; };
const checkPin = async (pin: string, stored: string) => { const [, s, h] = String(stored || "").split("$"); return !!s && (await pbkdf2(pin, s)) === h; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const b = await req.json().catch(() => ({}));
  const db = createClient(URL_, SRK);
  const phone = p10(b.phone);
  if (phone.length !== 10) return json({ error: "Enter your 10-digit phone number." });
  const { data: gym } = await db.from("gyms").select("id,slug,name").eq("slug", String(b.gym || "fliplab")).maybeSingle();
  if (!gym) return json({ error: "Gym not found." });
  const FL = gym.slug === "fliplab", WHO = FL ? "text Coach Steve" : "contact your coach";

  // Is this phone a parent of an active student?
  const { data: kids } = await db.from("students").select("id,parent_phone,parent_email,active").eq("gym_id", gym.id).ilike("parent_phone", `%${phone.slice(-4)}%`).limit(200);
  const mine = (kids || []).filter(k => p10(k.parent_phone) === phone && k.active !== false);
  const found = mine.length > 0;
  if (!found) return json({ error: "not_found" });
  const { data: acct } = await db.from("parent_accounts").select("*").eq("gym_id", gym.id).eq("phone", phone).maybeSingle();

  async function session() {
    const email = `p${phone}.${gym.slug}@parents.fliplab3.app`;
    if (!acct?.user_id) await db.auth.admin.createUser({ email, email_confirm: true, user_metadata: { portal: true, gym: gym.slug } });   // ignore "already registered"
    const { data: link, error } = await db.auth.admin.generateLink({ type: "magiclink", email });
    if (error || !link?.properties?.hashed_token) return json({ error: "Couldn't log you in. Try again." }, 500);
    const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { data: v, error: e2 } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "magiclink" });
    if (e2 || !v?.session) return json({ error: "Couldn't log you in. Try again." }, 500);
    await db.from("parent_accounts").update({ user_id: link.user.id, last_login_at: new Date().toISOString(), fails: 0, locked_until: null }).eq("gym_id", gym.id).eq("phone", phone);
    return json({ session: { access_token: v.session.access_token, refresh_token: v.session.refresh_token } });
  }

  switch (b.action) {
    case "check":
      return json({ found: true, has_pin: !!acct?.pin_hash });

    case "send_code": {
      const hourAgo = new Date(Date.now() - 3600e3).toISOString();
      const { count } = await db.from("portal_codes").select("id", { count: "exact", head: true }).eq("gym_id", gym.id).eq("phone", phone).gte("created_at", hourAgo);
      if ((count || 0) >= 3) return json({ error: `Too many codes. Try again in an hour, or ${WHO}.` });
      if (!FL) {   // other gyms: email from the gym's own connected email
        const to = String(mine.find(k => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(k.parent_email || "").trim()))?.parent_email || "").trim();
        const { data: cr } = await db.rpc("gym_email_get", { p_gym: gym.id });
        const c = (cr || [])[0];
        if (!to || !c || !HOSTS[c.provider]) return json({ error: "no_email" });
        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
        const id = crypto.randomUUID(), GN = gym.name || "Your gym";
        const text = `Your ${GN} parent portal code is ${code}. It expires in 10 minutes.\n\nIf you didn't ask for this, you can ignore this email.`;
        try {
          const client = new SMTPClient({ connection: { hostname: HOSTS[c.provider], port: 465, tls: true, auth: { username: c.address, password: c.pw } } });
          await client.send({ from: `${GN} <${c.address}>`, to, replyTo: c.address, subject: `Your ${GN} portal code: ${code}`, content: text,
            html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5">Your ${GN} parent portal code is <b style="font-size:20px;letter-spacing:2px">${code}</b><br>It expires in 10 minutes.<br><br><span style="color:#777">If you didn't ask for this, you can ignore this email.</span></div>` });
          await client.close();
        } catch (_e) { return json({ error: `Couldn't send the email. Try again or ${WHO}.` }, 500); }
        await db.from("portal_codes").insert({ id, gym_id: gym.id, phone, code_hash: await sha(code + phone + id), expires_at: new Date(Date.now() + 600e3).toISOString() });
        await db.from("email_log").insert({ gym_id: gym.id, to_email: to, subject: "Parent portal login code", body: "Login code sent (phone " + phone + ")", status: "Portal code" }).then(() => {}, () => {});
        return json({ ok: true, via: "email", to: mask(to) });
      }
      const u = Deno.env.get("SMSGATE_USER"), pw = Deno.env.get("SMSGATE_PASS");
      if (!u || !pw) return json({ error: "Texting isn't set up." }, 500);
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
      const id = crypto.randomUUID();
      const text = `Your ${gym.name || "Flip Lab"} parent portal code is ${code}. It expires in 10 minutes.`;
      const r = await fetch("https://api.sms-gate.app/3rdparty/v1/message", { method: "POST",
        headers: { Authorization: "Basic " + btoa(u + ":" + pw), "Content-Type": "application/json" },
        body: JSON.stringify({ textMessage: { text }, phoneNumbers: ["+1" + phone], withDeliveryReport: false }) });
      if (!r.ok) return json({ error: "Couldn't send the text. Try again or text Coach Steve." }, 500);
      await db.from("portal_codes").insert({ id, gym_id: gym.id, phone, code_hash: await sha(code + phone + id), expires_at: new Date(Date.now() + 600e3).toISOString() });
      await db.from("text_log").insert({ gym_id: gym.id, direction: "OUT", phone, body: "Parent portal login code sent", status: "Portal code", received_at: new Date().toISOString(), extra: { portal: true } });
      return json({ ok: true });
    }

    case "verify": {
      const { data: c } = await db.from("portal_codes").select("*").eq("gym_id", gym.id).eq("phone", phone).is("verified_at", null).is("used_at", null)
        .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!c) return json({ error: "That code expired. Tap \"Send a new code\"." });
      if (c.attempts >= 5) return json({ error: "Too many tries. Tap \"Send a new code\"." });
      if ((await sha(String(b.code || "").trim() + phone + c.id)) !== c.code_hash) {
        await db.from("portal_codes").update({ attempts: c.attempts + 1 }).eq("id", c.id);
        return json({ error: "That code isn't right." });
      }
      const token = rand(24);
      await db.from("portal_codes").update({ verified_at: new Date().toISOString(), set_token_hash: await sha(token) }).eq("id", c.id);
      return json({ token });
    }

    case "set_pin": {
      const pin = String(b.pin || "");
      if (!/^\d{4,6}$/.test(pin)) return json({ error: "Your code must be 4 to 6 numbers." });
      const since = new Date(Date.now() - 15 * 60e3).toISOString();
      const { data: c } = await db.from("portal_codes").select("id").eq("gym_id", gym.id).eq("phone", phone).eq("set_token_hash", await sha(String(b.token || "")))
        .is("used_at", null).gte("verified_at", since).maybeSingle();
      if (!c) return json({ error: "That took too long. Start again." });
      await db.from("portal_codes").update({ used_at: new Date().toISOString() }).eq("id", c.id);
      const pin_hash = await hashPin(pin);
      if (acct) await db.from("parent_accounts").update({ pin_hash, fails: 0, locked_until: null }).eq("id", acct.id);
      else await db.from("parent_accounts").insert({ gym_id: gym.id, phone, pin_hash });
      return await session();
    }

    case "login": {
      if (!acct?.pin_hash) return json({ error: "no_pin" });
      if (acct.locked_until && new Date(acct.locked_until) > new Date()) {
        const m = Math.ceil((new Date(acct.locked_until).getTime() - Date.now()) / 60e3);
        return json({ error: `Too many wrong tries. Try again in ${m} min, or tap "Forgot my code".` });
      }
      if (!(await checkPin(String(b.pin || ""), acct.pin_hash))) {
        const fails = (acct.fails || 0) + 1;
        await db.from("parent_accounts").update(fails >= 5 ? { fails: 0, locked_until: new Date(Date.now() + 15 * 60e3).toISOString() } : { fails }).eq("id", acct.id);
        return json({ error: fails >= 5 ? "Too many wrong tries. Locked for 15 min." : "That code isn't right." });
      }
      return await session();
    }
  }
  return json({ error: "Unknown action" }, 400);
});
