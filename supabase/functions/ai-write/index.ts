// FlipLab 3.0 — AI help writing parent texts (Communicate tab). Signed-in user only (verify_jwt on).
// Body: { mode: "reply" (thread, parent, kid, idea?) | "draft" | "shorter" | "friendlier" | "professional" | "onetext", idea?: string, text?: string, audience?: string }
// Secret: ANTHROPIC_API_KEY. Returns { text }.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `You write text messages from Coach Steve at Flip Lab to parents. Flip Lab is Steve's own private tumbling and gymnastics coaching business in Loveland, Ohio; most athletes are cheerleaders, some are dancers. He coaches private, shared and small-group lessons, keeps a waitlist, and sends families in his system the open times from cancellations each week; spots are first come, first served and they pick a day and time from what's open. Sunday is his limited, overflow day. (Mention these only when they fit what the coach asked.)

Write exactly the way Steve writes. His voice:
- Opens with a simple greeting, e.g. "Hi {parent}!" Do NOT add "this is Coach Steve" or introduce himself (use "Good morning/afternoon/evening" only if the coach mentions the time of day).
- Warm, personal and genuine, like he's talking to the parent face to face. He thanks people for reaching out and says what he'd "love" to do for their athlete.
- Plain, conversational sentences, not corporate or salesy. Explains the situation honestly (e.g. "right now I am currently full but I do have a waitlist").
- With families he already knows he's shorter and more casual: "Hi {parent}, good to hear from you." Bad news is plain and kind ("Unfortunately I don't have any open permanent spots right now as I'm full"), then right away what he CAN offer ("but I do have people who go on vacation or cancel and we can fill those spots"). He can be playful ("Lol yes I do") and talks in run-on, spoken-style sentences; keep that easy flow but make it readable.
- Ends with a clear, easy next step, e.g. "If you're interested let me know and I'll send over ..." No sign-off line, no emojis, no pile of exclamation marks.
- Use {kid} for the athlete's first name where it fits and keep {parent} and {kid} exactly as written.

Rules:
- Use only facts the coach gives you. Never invent dates, times, prices, policies or names.
- Fix grammar and punctuation, but keep his natural, friendly wording.
- Reply with only the message text.`;

// Other gyms: a plain friendly coach voice with their own gym + coach name (never Steve / Flip Lab / Loveland)
const SYSTEM_GYM = (gym: string, coach: string) => `You write text messages from ${coach} at ${gym} to parents of athletes they coach.

Voice:
- Opens with a simple greeting, e.g. "Hi {parent}!" Do NOT have the coach introduce themselves.
- Warm, friendly and genuine, in plain conversational sentences. Not corporate or salesy.
- Bad news is plain and kind, then right away what the coach CAN offer.
- Ends with a clear, easy next step. No sign-off line, no emojis, no pile of exclamation marks.
- Use {kid} for the athlete's first name where it fits and keep {parent} and {kid} exactly as written.

Rules:
- Use only facts the coach gives you. Never invent dates, times, prices, policies or names.
- Fix grammar and punctuation, but keep the coach's natural, friendly wording.
- Reply with only the message text.`;

const ASK: Record<string, (b: any) => string> = {
  draft: b => `Write a text to ${b.audience || "families"} about this: ${b.idea}`,
  shorter: b => `Make this text shorter in ${b._fl ? "Steve's" : "the same"} voice, keeping every fact:\n${b.text}`,
  friendlier: b => `Make this text warmer and friendlier, keeping every fact:\n${b.text}`,
  professional: b => `Make this text more professional, keeping every fact:\n${b.text}`,
  reply: b => `Write ${b._fl ? "Steve's" : "the coach's"} reply to ${b.parent || "the parent"}${b.kid ? " (parent of " + b.kid + ")" : ""}. This goes to one person, so use their real first name, not {parent} or {kid}. Only use facts from the conversation or the coach's note; if you'd need a fact you don't have, keep it general. Conversation so far, oldest first:\n${b.thread}\n\nCoach's note on what to say (may be empty): ${b.idea || ""}`,
  onetext: b => `Rewrite this text to fit in one SMS: 150 characters or fewer counting {parent} and {kid} as 8 characters each. Keep the key facts:\n${b.text}`,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: gyms } = await user.from("gyms").select("id,slug,name").limit(1);
  if (!gyms?.length) return json({ error: "Not signed in" }, 401);
  // Steve, Nov 8: AI writing is Flip Lab only for now (runs on Steve's key). SYSTEM_GYM kept for turning it back on later.
  if (gyms[0].slug !== "fliplab") return json({ error: "AI writing isn't available for your gym." }, 403);
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "AI isn't set up yet (ANTHROPIC_API_KEY secret missing)" }, 500);
  const b = await req.json().catch(() => ({}));
  let system = SYSTEM;
  b._fl = gyms[0].slug === "fliplab";
  if (!b._fl) {
    const { data: co } = await user.from("coaches").select("name").eq("gym_id", gyms[0].id).eq("active", true).order("created_at").limit(1).maybeSingle();
    const cn = co?.name ? (/^coach\b/i.test(co.name) ? co.name : "Coach " + co.name) : "the coach";
    system = SYSTEM_GYM(gyms[0].name || "their gym", cn);
  }
  const ask = ASK[b.mode];
  if (!ask || (b.mode === "draft" ? !b.idea : b.mode === "reply" ? !b.thread : !b.text)) return json({ error: "Nothing to work with" }, 400);
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 600, system, messages: [{ role: "user", content: ask(b).slice(0, 4000) }] }) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: out?.error?.message || "AI error " + r.status }, 502);
  return json({ text: (out.content || []).map((c: any) => c.text || "").join("").trim() });
});
