// FlipLab 3.0 — student import: AI guesses which spreadsheet column is which field. Signed-in users only (verify_jwt on).
// Body: { headers: string[], samples: string[][] (max 3 rows) }. Returns { map: { [header]: field } }.
// Only headers + 3 sample rows are sent, never the whole file. Secret: ANTHROPIC_API_KEY.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const FIELDS = ["full_name", "first_name", "last_name", "dob", "parent_name", "phone", "email", "level", "notes", "lesson_day", "lesson_time", "lesson_daytime", "waiver", "skip"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") || "" } } });
  const { data: gyms } = await user.from("gyms").select("id").limit(1);
  if (!gyms?.length) return json({ error: "Not signed in" }, 401);
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: "AI isn't set up" }, 500);
  const b = await req.json().catch(() => ({}));
  const headers: string[] = (b.headers || []).slice(0, 40).map((h: unknown) => String(h).slice(0, 60));
  const samples: string[][] = (b.samples || []).slice(0, 3).map((r: unknown[]) => (r || []).slice(0, 40).map((c) => String(c ?? "").slice(0, 60)));
  if (!headers.length) return json({ error: "No columns" }, 400);
  const prompt = `A tumbling/gymnastics coach is importing students from a spreadsheet exported from another program. Match each column to one field.
Fields: full_name (student's whole name), first_name, last_name (student), dob (student birthday), parent_name, phone (parent phone), email (parent email), level (skill level/class level), notes, lesson_day (weekday of their weekly lesson), lesson_time (time of day of the lesson), lesson_daytime (day and time together in one column), waiver (waiver signed yes/no or signed date), skip (anything else, e.g. IDs, balances, addresses).
Use each field at most once except skip. If both a student name and a parent name exist, choose carefully using the sample values.
Columns: ${JSON.stringify(headers)}
Sample rows: ${JSON.stringify(samples)}
Reply with JSON only: {"<column>": "<field>", ...} covering every column.`;
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 800, messages: [{ role: "user", content: prompt }] }) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: out?.error?.message || "AI error " + r.status }, 502);
  const text = (out.content || []).map((c: any) => c.text || "").join("");
  let map: Record<string, string> = {};
  try { map = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch { return json({ error: "AI reply unreadable" }, 502); }
  const clean: Record<string, string> = {};
  headers.forEach((h) => { clean[h] = FIELDS.includes(map[h]) ? map[h] : "skip"; });
  return json({ map: clean });
});
