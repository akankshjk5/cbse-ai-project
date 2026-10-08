/**
 * Preload stub for running server-side modules outside Next.
 *
 * `server-only` deliberately throws when it is loaded by anything other than
 * Next's server bundler. That guard is correct in the app; it just gets in the
 * way of a plain Node smoke test, so this neutralises the module for scripts
 * only. Never require this from application code.
 */

const Module = require('node:module');

const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};
