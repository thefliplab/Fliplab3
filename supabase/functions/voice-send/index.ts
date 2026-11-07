// FlipLab 3.0 — send a text from Steve's Google Voice number (no Voice API; same trick as 2.0 sendVoiceReply_).
// Voice forwards each text to Gmail from a special address (…@txt.voice.google.com). Emailing that address from the
// Gmail that owns Voice sends a text from the Voice number. Only works for families who texted the Voice number lately.
// Signed-in user only (verify_jwt on).
//   List:  { list: true }                    → { ok, families: [{ phone, last }] }  (everyone who ever texted Voice, from Gmail)
//   Check: { check: "5135551234" }            → { ok: true/false }  (is there a recent Voice email for that phone?)
//   Send:  { to, text, student_id?, family?, batch? }  → logs text_log OUT (status "Sent (Voice)", extra.line Voice, extra.batch for Communicate sends)
// Secrets: GMAIL_VOICE_APP_PASSWORD. Gmail address: GMAIL_VOICE_USER secret or the default below.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const d10 = (p: string) => String(p || "").replace(/\D/g, "").slice(-10);

// ---- tiny IMAP client (Gmail, TLS 993) ----
async function imap(user: string, pw: string) {
  const conn = await Deno.connectTls({ hostname: "imap.gmail.com", port: 993 });
  const enc = new TextEncoder(), dec = new TextDecoder();
  let buf = "", n = 0;
  const readUntil = async (re: RegExp) => {
    const chunk = new Uint8Array(65536);
    const until = Date.now() + 20000;
    while (!re.test(buf)) {
      if (Date.now() > until) throw new Error("Gmail took too long");
      const k = await conn.read(chunk); if (k === null) throw new Error("Gmail closed the connection");
      buf += dec.decode(chunk.subarray(0, k));
    }
    const out = buf; buf = ""; return out;
  };
  await readUntil(/\r\n/);                                   // greeting
  const cmd = async (c: string) => { const tag = "a" + (++n); await conn.write(enc.encode(`${tag} ${c}\r\n`));
    const r = await readUntil(new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`));
    if (!new RegExp(`${tag} OK`).test(r)) throw new Error("Gmail: " + (r.match(new RegExp(`${tag} (NO|BAD)([^\\r\\n]*)`))?.[2] || "error").trim());
    return r; };
  const q = (s: string) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  await cmd(`LOGIN ${q(user)} ${q(pw.replace(/\s/g, ""))}`);
  return { cmd, close: () => { try { conn.close(); } catch (_) { /* */ } } };
}

// Newest Voice email from this phone in the last 30 days → { from, msgId, subject }
async function findVoice(user: string, pw: string, p10: string) {
  const c = await imap(user, pw);
  try {
    await c.cmd('EXAMINE "[Gmail]/All Mail"');
    const s = await c.cmd('UID SEARCH X-GM-RAW "from:txt.voice.google.com newer_than:30d"');
    const uids = ((s.match(/\* SEARCH([^\r\n]*)/) || [])[1] || "").trim().split(/\s+/).filter(Boolean).map(Number).sort((a, b) => b - a).slice(0, 500);
    if (!uids.length) return null;
    const f = await c.cmd(`UID FETCH ${uids.join(",")} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT MESSAGE-ID)])`);
    const parts = f.split(/\r\n(?=\* \d+ FETCH)/).map((x) => {
      const uid = Number((x.match(/UID (\d+)/) || [])[1] || 0);
      const hdr = x.replace(/\r\n[ \t]+/g, " ");
      const from = ((hdr.match(/^From:.*?<?([^\s<>"]+@txt\.voice\.google\.com)>?/im) || [])[1] || "");
      const subj = ((hdr.match(/^Subject:\s*(.*)$/im) || [])[1] || "").trim();
      const msgId = ((hdr.match(/^Message-ID:\s*(<[^>]+>)/im) || [])[1] || "");
      return { uid, from, subj, msgId };
    }).filter((x) => x.from).sort((a, b) => b.uid - a.uid);
    return parts.find((x) => (x.from.replace(/\D/g, "") + " " + x.subj.replace(/\D/g, "")).includes(p10)) || null;
  } finally { c.close(); }
}

// Every family that ever texted the Voice number (all Voice emails in Gmail, newest 3000) → [{ phone, last }] newest first
const ME = "5134432674";   // Steve's own Voice number (left out)
async function listVoice(user: string, pw: string) {
  const c = await imap(user, pw);
  try {
    await c.cmd('EXAMINE "[Gmail]/All Mail"');
    const s = await c.cmd('UID SEARCH X-GM-RAW "from:txt.voice.google.com"');
    const uids = ((s.match(/\* SEARCH([^\r\n]*)/) || [])[1] || "").trim().split(/\s+/).filter(Boolean).map(Number).sort((a, b) => b - a).slice(0, 3000);
    const seen: Record<string, string> = {};
    for (let i = 0; i < uids.length; i += 500) {
      const f = await c.cmd(`UID FETCH ${uids.slice(i, i + 500).join(",")} (INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])`);
      for (const x of f.split(/\r\n(?=\* \d+ FETCH)/)) {
        const hdr = x.replace(/\r\n[ \t]+/g, " ");
        const subj = ((hdr.match(/^Subject:\s*(.*)$/im) || [])[1] || "");
        const from = ((hdr.match(/^From:.*?<?([^\s<>"]+@txt\.voice\.google\.com)>?/im) || [])[1] || "");
        if (!from) continue;
        const m = subj.match(/\((\d{3})\)\s*(\d{3})-(\d{4})/);
        const p10 = m ? m[1] + m[2] + m[3] : ((from.split("@")[0].split(".").map(d10).filter((d) => d.length === 10 && d !== ME))[0] || "");
        if (!p10 || p10 === ME) continue;
        const dt = new Date(((x.match(/INTERNALDATE "([^"]+)"/) || [])[1] || "").replace(/-/g, " "));
        const iso = isNaN(dt.getTime()) ? "" : dt.toISOString();
        if (!seen[p10] || iso > seen[p10]) seen[p10] = iso;
      }
    }
    return Object.entries(seen).map(([phone, last]) => ({ phone, last })).sort((a, b) => b.last.localeCompare(a.last));
  } finally { c.close(); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: gyms } = await user.from("gyms").select("id,slug").limit(1);
  if (!gyms?.length) return json({ error: "Not signed in" }, 401);
  if (gyms[0].slug !== "fliplab") return json({ error: "Automatic texts and emails are not set up for this gym yet" }, 403);   // Steve's phone/Yahoo/Voice are Flip Lab only
  const gym = gyms[0].id;
  const pw = Deno.env.get("GMAIL_VOICE_APP_PASSWORD"), gmail = Deno.env.get("GMAIL_VOICE_USER") || "s.tsiegel21@gmail.com";
  if (!pw) return json({ error: "Google Voice sending isn't set up yet (GMAIL_VOICE_APP_PASSWORD secret missing)" }, 500);
  const b = await req.json().catch(() => ({}));

  try {
    if (b.list) return json({ ok: true, families: await listVoice(gmail, pw) });
    if (b.check) { const v = await findVoice(gmail, pw, d10(b.check)); return json({ ok: !!v }); }
    const p10 = d10(b.to), text = String(b.text || "").trim();
    if (p10.length !== 10 || !text) return json({ error: "Bad phone or empty text" }, 400);
    const v = await findVoice(gmail, pw, p10);
    if (!v) return json({ ok: false, error: "No Voice text from this family in the last 30 days — send from your cell instead." });
    const client = new SMTPClient({ connection: { hostname: "smtp.gmail.com", port: 465, tls: true, auth: { username: gmail, password: pw.replace(/\s/g, "") } } });
    await client.send({ from: gmail, to: v.from, subject: v.subj.startsWith("Re:") ? v.subj : "Re: " + v.subj, content: text,
      headers: v.msgId ? { "In-Reply-To": v.msgId, "References": v.msgId } : undefined });
    await client.close();
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await db.from("text_log").insert({ gym_id: gym, direction: "OUT", phone: p10, student_id: b.student_id || null, family_name: b.family || null,
      body: text, status: "Sent (Voice)", received_at: new Date().toISOString(), extra: b.batch ? { line: "Voice", batch: b.batch } : { line: "Voice" } });
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String((e as Error).message || e).slice(0, 300) });
  }
});
