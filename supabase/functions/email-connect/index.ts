// FlipLab 3.0 — a coach connects their OWN email (Gmail / Yahoo / AOL app password) so the app sends as their real address.
// Signed-in user (verify_jwt on). Not for Flip Lab (Steve's gym uses the YAHOO_* secrets).
//   { provider: "gmail"|"yahoo"|"aol", address, password }  → logs in + sends a test email to the address; saves password in Vault
//   { disconnect: true }                                     → forgets it
// Status for the admin page is written to gym_settings 'settings' (email_from, email_provider). The password is never sent back.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
export const HOSTS: Record<string, string> = { gmail: "smtp.gmail.com", yahoo: "smtp.mail.yahoo.com", aol: "smtp.aol.com" };   // all port 465 (Supabase blocks 587)

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: gyms } = await user.from("gyms").select("id,name,slug").limit(1);
  if (!gyms?.length) return json({ error: "Not signed in" }, 401);
  const g = gyms[0];
  if (g.slug === "fliplab") return json({ error: "Flip Lab already sends from thefliplab@yahoo.com" }, 400);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const b = await req.json().catch(() => ({}));
  const setStatus = async (patch: Record<string, unknown>) => {
    const { data: row } = await db.from("gym_settings").select("value").eq("gym_id", g.id).eq("key", "settings").maybeSingle();
    await db.from("gym_settings").upsert({ gym_id: g.id, key: "settings", value: { ...(row?.value || {}), ...patch }, updated_at: new Date().toISOString() });
  };

  if (b.disconnect) {
    await db.rpc("gym_email_forget", { p_gym: g.id });
    await setStatus({ email_from: "", email_provider: "" });
    return json({ ok: true });
  }
  const provider = String(b.provider || ""), address = String(b.address || "").trim().toLowerCase(), pw = String(b.password || "").replace(/\s/g, "");
  if (!HOSTS[provider]) return json({ error: "Pick Gmail, Yahoo or AOL" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || pw.length < 8) return json({ error: "Enter your email and the app password" }, 400);
  try {
    const client = new SMTPClient({ connection: { hostname: HOSTS[provider], port: 465, tls: true, auth: { username: address, password: pw } } });
    await client.send({ from: `${g.name} <${address}>`, to: address, subject: "FlipLab is connected to your email ✓",
      content: `This is a test from FlipLab.\n\nEmails to your families will now come from ${address}, and their replies come right back to this inbox.` });
    await client.close();
  } catch (e) {
    const m = String((e as Error)?.message || e);
    return json({ ok: false, error: /auth|535|534|password|credentials|login/i.test(m)
      ? "Your email said no to that password. Make sure it's an app password (not your normal password) and try again."
      : "Couldn't connect: " + m.slice(0, 200) });
  }
  const r = await db.rpc("gym_email_save", { p_gym: g.id, p_provider: provider, p_address: address, p_pw: pw });
  if (r.error) return json({ ok: false, error: r.error.message }, 500);
  await setStatus({ email_from: address, email_provider: provider });
  return json({ ok: true, address });
});
