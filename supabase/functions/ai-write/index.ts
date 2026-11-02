// FlipLab 3.0 — AI help writing parent texts (Communicate tab). Signed-in user only (verify_jwt on).
// Body: { mode: "draft" | "shorter" | "friendlier" | "professional" | "onetext", idea?: string, text?: string, audience?: string }
// Secret: ANTHROPIC_API_KEY. Returns { text }.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const SYSTEM = `You write short text messages from Coach Steve at Flip Lab (a private tumbling and gymnastics coaching gym; most athletes are cheerleaders) to parents.
Rules:
- Plain text only. No emojis unless the coach's idea uses them. No hashtags, no quotes around the message.
- Start with "Hi {parent}!" and use {kid} for the athlete's first name where it fits. Keep {parent} and {kid} exactly as written.
- Warm, clear and brief, like a coach texting a family he knows. Say exactly what the parent needs to know or do.
- Never invent dates, times, prices or policies that the coach did not give.
- Reply with only the message text.`;

const ASK: Record<string, (b: any) => string> = {
  draft: b => `Write a text to ${b.audience || "families"} about this: ${b.idea}`,
  shorter: b => `Make this text shorter, keeping every fact:\n${b.text}`,
  friendlier: b => `Make this text warmer and friendlier, keeping every fact:\n${b.text}`,
  professional: b => `Make this text more professional, keeping every fact:\n${b.text}`,
  onetext: b => `Rewrite this text to fit in one SMS: 150 characters or fewer counting {parent} and {kid} as 8 characters each. Keep the key facts:\n${b.text}`,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: gyms } = await user.from("gyms").select("id").limit(1);
  if (!gyms?.length) return json({ error: "Not signed in" }, 401);
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "AI isn't set up yet (ANTHROPIC_API_KEY secret missing)" }, 500);
  const b = await req.json().catch(() => ({}));
  const ask = ASK[b.mode];
  if (!ask || (b.mode === "draft" ? !b.idea : !b.text)) return json({ error: "Nothing to work with" }, 400);
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 400, system: SYSTEM, messages: [{ role: "user", content: ask(b).slice(0, 2000) }] }) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: out?.error?.message || "AI error " + r.status }, 502);
  return json({ text: (out.content || []).map((c: any) => c.text || "").join("").trim() });
});
