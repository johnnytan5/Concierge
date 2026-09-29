import { CALL_SECONDS, WS_URL, callToken, createAgent, db, loadMenu, webCallsToday } from '../../../../lib/voice/server';
import { clientIp, refusal, type LimitRow } from '../../../../lib/voice/limits';

/**
 * Start a web call: check the daily limit, build a stored agent for the room
 * (prompt + live menu + OpenRouter key, all server-side), register the
 * voice_sessions row, and hand the browser a one-time token for the WebSocket.
 * The token caps the session at CALL_SECONDS on AssemblyAI's side.
 *
 * Rate limits (lib/voice/limits.ts) are checked first, from call_limits:
 * per IP (main), per browser client id and fingerprint (assist), then the
 * global DEMO_DAILY_CALL_LIMIT. Nothing is created for a refused call.
 */
const ROOMS = ['0803', '0804', '1204', '1205'];

export async function POST(request: Request) {
  const { room, client_id, fingerprint } = await request.json().catch(() => ({}));
  if (!ROOMS.includes(room)) return Response.json({ error: 'unknown room' }, { status: 400 });
  const who = {
    ip: clientIp(request.headers),
    clientId: typeof client_id === 'string' && /^[0-9a-f-]{36}$/.test(client_id) ? client_id : null,
    fingerprint: typeof fingerprint === 'string' && /^[0-9a-f]{64}$/.test(fingerprint) ? fingerprint : null,
  };

  try {
    // Raw IPs are kept a week, no longer (the owner's choice; see the migration).
    await db().from('call_limits').delete().lt('started_at', new Date(Date.now() - 7 * 864e5).toISOString());
    const since = new Date(Date.now() - 864e5).toISOString();
    // values quoted: IPv6 has colons; the ids are validated hex/uuid above
    const q = (v: string) => `"${v.replace(/["\\]/g, '')}"`;
    const match = [`ip.eq.${q(who.ip)}`, who.clientId && `client_id.eq.${q(who.clientId)}`,
      who.fingerprint && `fingerprint.eq.${q(who.fingerprint)}`].filter(Boolean).join(',');
    const { data: recent, error: limErr } = await db().from('call_limits')
      .select('ip,client_id,fingerprint,started_at,ended_at').gte('started_at', since).or(match);
    if (limErr) throw new Error(`limits: ${limErr.message}`);
    // ponytail: check-then-insert, so two starts in the same instant can both
    // pass; one extra call at worst.
    const why = refusal((recent ?? []) as LimitRow[], who);
    if (why) return Response.json({ error: why }, { status: 429 });

    const limit = Number(process.env.DEMO_DAILY_CALL_LIMIT ?? 100);
    if ((await webCallsToday()) >= limit) {
      return Response.json({ error: 'The demo line has reached today\'s call limit. Please try again tomorrow.' }, { status: 429 });
    }
    const menu = await loadMenu();
    const [agentId, token] = await Promise.all([createAgent(room, menu), callToken()]);
    const sessionId = 'web_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    const { error } = await db().from('voice_sessions').insert({ id: sessionId, agent_id: agentId, room });
    if (error) throw new Error(`session: ${error.message}`);
    const lim = await db().from('call_limits').insert({ session_id: sessionId, ip: who.ip, client_id: who.clientId, fingerprint: who.fingerprint });
    if (lim.error) throw new Error(`limits: ${lim.error.message}`);
    return Response.json({ session_id: sessionId, agent_id: agentId, token, ws_url: WS_URL, menu, seconds: CALL_SECONDS });
  } catch (e) {
    console.error('[call/start]', e);
    return Response.json({ error: 'Could not start the call. Please try again.' }, { status: 502 });
  }
}
