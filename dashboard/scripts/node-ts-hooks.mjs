// Lets plain Node (type stripping) run lib/ modules the way the Next bundler
// does: extensionless relative imports resolve to .ts, and .json imports need
// no `with { type: 'json' }`. Used by the self-checks:
//   node --import ./scripts/node-ts-hooks.mjs scripts/<check>.mts
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.[cm]?[jt]s$|\.json$/.test(specifier)) {
      const ts = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
    }
    const r = next(specifier, context);
    return r.url.endsWith('.json') ? { ...r, importAttributes: { type: 'json' } } : r;
  },
});
