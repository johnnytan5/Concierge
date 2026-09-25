/**
 * Who may start a web call right now: pure logic over the caller's recent
 * call_limits rows (last 24 h, rolling), so it runs in the route and in the
 * self-check alike. IP is the main signal; the browser's client id and
 * fingerprint only assist (both can be reset, and identical laptops can share
 * a fingerprint, hence its looser cap).
 */
export const LIMITS = {
  ipCalls: 3,
  ipMinutes: 9,
  clientCalls: 3,
  fingerprintCalls: 6,
  callSeconds: 180,
};

export type LimitRow = {
  ip: string; client_id: string | null; fingerprint: string | null;
  started_at: string; ended_at: string | null;
};

/** Seconds a call counts for. A closed call: its real length, uncapped -- a
 *  client that skipped the page's 3-min timer pays for the overrun. A call
 *  that never reported its end (tab crashed, or a script that just stops
 *  reporting): the full call length, no more, or a crash would lock a real
 *  visitor out for the day. The server cannot see the live session itself. */
function charged(r: LimitRow, now: number) {
  const start = Date.parse(r.started_at);
  if (r.ended_at) return Math.max(0, Date.parse(r.ended_at) - start) / 1000;
  return Math.min(Math.max(0, now - start) / 1000, LIMITS.callSeconds);
}

/** null when allowed, else the reason to show the visitor. */
export function refusal(rows: LimitRow[], who: { ip: string; clientId: string | null; fingerprint: string | null }, now = Date.now()): string | null {
  const day = rows.filter((r) => now - Date.parse(r.started_at) < 24 * 3600 * 1000);
  const byIp = day.filter((r) => r.ip === who.ip);
  const open = byIp.some((r) => !r.ended_at && now - Date.parse(r.started_at) < (LIMITS.callSeconds + 30) * 1000);
  if (open) return 'You already have a call open. Hang up that one first.';
  const tomorrow = ' The demo line allows 3 calls (9 minutes) a day per visitor — please come back tomorrow.';
  if (byIp.length >= LIMITS.ipCalls) return 'You have used today\'s demo calls.' + tomorrow;
  if (byIp.reduce((s, r) => s + charged(r, now), 0) >= LIMITS.ipMinutes * 60) return 'You have used today\'s demo minutes.' + tomorrow;
  if (who.clientId && day.filter((r) => r.client_id === who.clientId).length >= LIMITS.clientCalls) return 'You have used today\'s demo calls.' + tomorrow;
  if (who.fingerprint && day.filter((r) => r.fingerprint === who.fingerprint).length >= LIMITS.fingerprintCalls) return 'You have used today\'s demo calls.' + tomorrow;
  return null;
}

/** The caller's IP as Vercel reports it (first hop of x-forwarded-for). */
export function clientIp(h: Headers) {
  return (h.get('x-forwarded-for')?.split(',')[0] ?? h.get('x-real-ip') ?? 'unknown').trim().slice(0, 64);
}
