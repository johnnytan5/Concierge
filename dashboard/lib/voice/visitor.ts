/**
 * The browser's half of rate limiting (lib/voice/limits.ts): a random id kept
 * in localStorage, and a light fingerprint that survives a VPN or Wi-Fi
 * change. Both are soft signals -- clearing storage or switching browsers
 * resets them -- the server's IP check is the real one.
 */
const KEY = 'concierge.clientId';

export function clientId(): string | null {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY, id); }
    return id;
  } catch {
    return null; // storage blocked (private window): IP still limits
  }
}

/** SHA-256 over stable device traits: GPU, canvas text rendering, screen, locale. */
export async function fingerprint(): Promise<string | null> {
  try {
    const parts: unknown[] = [
      screen.width, screen.height, screen.colorDepth, devicePixelRatio,
      Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.languages?.join(','),
      navigator.hardwareConcurrency, (navigator as { deviceMemory?: number }).deviceMemory, navigator.platform,
    ];
    const gl = document.createElement('canvas').getContext('webgl');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    if (gl && dbg) parts.push(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL), gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
    const c = document.createElement('canvas');
    c.width = 240; c.height = 40;
    const x = c.getContext('2d');
    if (x) {
      x.textBaseline = 'top'; x.font = '16px Arial'; x.fillStyle = '#f60'; x.fillRect(100, 1, 62, 20);
      x.fillStyle = '#069'; x.fillText('Concierge ✓ 1204', 2, 15);
      parts.push(c.toDataURL());
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
