import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import config from './agent-config.json';
import { menuForPrompt, type MenuItem } from './menu';

/**
 * Server side of the web call: everything that needs a secret. Import only
 * from route handlers (app/api/**). Keys come from server-only env vars
 * (never NEXT_PUBLIC_), so they never reach the browser:
 *   ASSEMBLYAI_API_KEY, OPENROUTER_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Mirrors orchestrator/agent.py (stored agent) and orchestrator/inventory.py
 * (the audit writes).
 */

export const CALL_SECONDS = 180;
const AGENTS_URL = 'https://agents.assemblyai.com/v1/agents';
const TOKEN_URL = 'https://agents.assemblyai.com/v1/token';

function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`server is missing ${name}`);
  return v;
}

let _db: SupabaseClient | null = null;
export function db() {
  _db ??= createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  return _db;
}

export async function loadMenu(): Promise<MenuItem[]> {
  const { data, error } = await db().from('inventory_items').select('name,category,price,dietary_tags,available,stock_count');
  if (error) throw new Error(`menu: ${error.message}`);
  return (data ?? []).map((r) => ({
    name: r.name, category: r.category, price: r.price, dietary_tags: r.dietary_tags ?? [],
    available: r.available, in_stock: r.stock_count === null || r.stock_count > 0, stock: r.stock_count,
  }));
}

/** Web calls started today (UTC), for DEMO_DAILY_CALL_LIMIT. */
export async function webCallsToday() {
  const day = new Date().toISOString().slice(0, 10);
  const { count, error } = await db().from('voice_sessions').select('id', { count: 'exact', head: true })
    .like('id', 'web_%').gte('started_at', `${day}T00:00:00Z`);
  if (error) throw new Error(`limit: ${error.message}`);
  return count ?? 0;
}

/** Same prompt as orchestrator/agent.py system_prompt_for(room). */
function systemPrompt(room: string, menu: MenuItem[]) {
  return `${config.base_prompt}\n\n${menuForPrompt(menu)}\n\n` +
    `This call is coming from room ${room} — the switchboard already ` +
    `identified it, so do NOT ask the guest which room they are in. Use ` +
    `${room} as the room for dispatch_delivery, check_delivery_status and ` +
    `escalate_to_frontdesk unless the guest explicitly asks for something ` +
    `to go to a different room.`;
}

async function assembly(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${env('ASSEMBLYAI_API_KEY')}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
  });
  // Never echo the body: a 422 once came back with the api keys in it
  // (orchestrator/agent.py _redact()).
  if (!res.ok) throw new Error(`AssemblyAI ${new URL(url).pathname} failed (${res.status})`);
  return res.json();
}

/** A fresh stored agent per call (they expire within minutes; agent.py's TTL note). */
export async function createAgent(room: string, menu: MenuItem[]): Promise<string> {
  const keyterms = config.keyterms.includes(room) ? config.keyterms : [...config.keyterms, room];
  const body = {
    name: 'concierge-front-desk-web',
    system_prompt: systemPrompt(room, menu),
    voice: config.voice,
    greeting: `Front desk, room ${room} — how can I help?`,
    input: { ...config.input, keyterms },
    tools: config.tools,
    llm: [{ base_url: config.llm_base_url, model: config.llm_model, api_key: env('OPENROUTER_API_KEY') }],
  };
  const data = await assembly(AGENTS_URL, { method: 'POST', body: JSON.stringify(body) });
  await untilReadable(data.id);
  return data.id;
}

/** A new stored agent is not visible to the session endpoint right away:
 *  on Vercel (close to AssemblyAI) the browser connected before it was and
 *  got agent_not_found every time. Wait until it reads back. */
async function untilReadable(id: string) {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${AGENTS_URL}/${id}`, {
      headers: { Authorization: `Bearer ${env('ASSEMBLYAI_API_KEY')}` }, cache: 'no-store',
    });
    if (res.ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('AssemblyAI agent never became readable');
}

/** One-time browser token; the server ends the session at CALL_SECONDS. */
export async function callToken(): Promise<string> {
  const q = new URLSearchParams({ expires_in_seconds: '60', max_session_duration_seconds: String(CALL_SECONDS) });
  return (await assembly(`${TOKEN_URL}?${q}`)).token;
}

/** A session the browser may still write to: a web call, started recently. */
export async function liveWebSession(id: unknown): Promise<boolean> {
  if (typeof id !== 'string' || !/^web_[0-9a-f]{12}$/.test(id)) return false;
  const { data } = await db().from('voice_sessions').select('started_at').eq('id', id).maybeSingle();
  if (!data) return false;
  // call length + grace for the robot to finish and the last mirror writes
  return Date.now() - new Date(data.started_at).getTime() < (CALL_SECONDS + 15 * 60) * 1000;
}
