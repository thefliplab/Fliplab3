// FlipLab 3.0 — incoming texts. SMS Gateway for Android (cloud) calls this webhook on sms:received.
// URL: /functions/v1/sms-receive?k=<gym_secrets.sms_rx_key>   (verify_jwt off; the key picks the gym)
// Only texts from a phone that matches a student/waitlist parent are saved (Steve, Nov 2) → text_log IN, status Unread.
// Setup:  ?k=..&register=1  → registers this URL as the gateway's sms:received webhook (replaces old ones).
// Deployed copy is the source of truth; the key lives only in table gym_secrets (not in this repo).
import { createClient } from "jsr:@supabase/supabase-js@2";

const GW = "https://api.sms-gate.app/3rdparty/v1";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const d10 = (p: string) => String(p || "").replace(/\D/g, "").slice(-10);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const k = url.searchParams.get("k") || "";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (!k) return json({ error: "no key" }, 403);
  const { data: sec } = await db.from("gym_secrets").select("gym_id").eq("sms_rx_key", k).maybeSingle();
  if (!sec) return json({ error: "bad key" }, 403);
  const gym = sec.gym_id;

  // ---- Register webhook with the gateway ----
  if (url.searchParams.get("register")) {
    const u = Deno.env.get("SMSGATE_USER"), pw = Deno.env.get("SMSGATE_PASS");
    const auth = { Authorization: "Basic " + btoa(u + ":" + pw) };
    const me = `${Deno.env.get("SUPABASE_URL")}/functions/v1/sms-receive?k=${k}`;
    const list = await (await fetch(`${GW}/webhooks`, { headers: auth })).json().catch(() => []);
    for (const w of Array.isArray(list) ? list : []) {
      if (w.event === "sms:received" && String(w.url || "").includes("/functions/v1/sms-receive")) await fetch(`${GW}/webhooks/${w.id}`, { method: "DELETE", headers: auth });
    }
    const r = await fetch(`${GW}/webhooks`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ url: me, event: "sms:received" }) });
    return json({ ok: r.ok, status: r.status, gateway: await r.text() });
  }

  // ---- Incoming text ----
  const b = await req.json().catch(() => ({}));
  if (b.event && b.event !== "sms:received") return json({ ignored: b.event });
  const p = b.payload || {};
  const text = p.message ?? p.text ?? p.textMessage?.text ?? "";
  const phone = d10(p.phoneNumber || p.sender || "");
  const gmid = p.messageId || b.id || null;
  if (phone.length !== 10 || !text) return json({ skipped: "no phone/text" });

  // match parent (student first, then waitlist)
  const last4 = phone.slice(-4);
  const { data: st } = await db.from("students").select("id,first_name,last_name,parent_name,parent_phone,status").eq("gym_id", gym).ilike("parent_phone", `%${last4}`);
  const kids = (st || []).filter((s) => d10(s.parent_phone) === phone);
  let wl: any[] = [];
  if (!kids.length) {
    const { data: w } = await db.from("waitlist").select("id,student_id,student_name,parent_name,parent_phone").eq("gym_id", gym).ilike("parent_phone", `%${last4}`);
    wl = (w || []).filter((x) => d10(x.parent_phone) === phone);
  }
  if (!kids.length && !wl.length) return json({ skipped: "not a parent" });

  if (gmid) {   // gateway can retry — don't save twice
    const { data: dup } = await db.from("text_log").select("id").eq("gym_id", gym).eq("direction", "IN").eq("extra->>gmid", gmid).limit(1);
    if (dup?.length) return json({ dup: true });
  }
  kids.sort((a, c) => (a.status === "Active" ? 0 : 1) - (c.status === "Active" ? 0 : 1));
  const first = kids[0];
  const row = {
    gym_id: gym, direction: "IN", phone, body: String(text).slice(0, 2000), status: "Unread",
    student_id: first ? first.id : (wl[0].student_id || null),
    family_name: first ? first.parent_name : wl[0].parent_name,
    received_at: p.receivedAt ? new Date(p.receivedAt).toISOString() : new Date().toISOString(),
    extra: { gmid, kids: kids.length ? kids.map((s) => s.first_name) : wl.map((x) => x.student_name), waitlist: !kids.length ? wl.map((x) => x.id) : undefined },
  };
  const { error } = await db.from("text_log").insert(row);
  return json(error ? { error: error.message } : { saved: true });
});
