/**
 * foray-terminal.com — the whole site.
 *
 * It serves exactly four things:
 *
 *   GET /            the landing page (one self-contained HTML file, one
 *                    inline script, hashed into the CSP)
 *   GET /install.sh  the installer, proxied from GitHub (see install.js)
 *   GET /hero.webp   the desktop screenshot on that page, bundled in
 *   GET /phone.webp  the phone screenshot, for narrow viewports
 *
 * Everything else is a plain-text 404. HEAD works everywhere GET does,
 * because tooling probes that way.
 */

import LANDING_HTML from './landing.html';
// Data modules: an ArrayBuffer each, straight out of the bundle. The one
// [[rules]] entry for **/*.webp in both wrangler configs covers every image
// here — a new screenshot needs no new config, only a line below.
import HERO_WEBP from './hero.webp';
import PHONE_WEBP from './phone.webp';
import { handleInstallScript } from './install.js';

/**
 * Each screenshot is immutable under its own name — a different picture gets a
 * different path — so they can be held for a year, browser and edge alike.
 */
const IMAGE_TTL_SECONDS = 31536000;

/**
 * The screenshots, by route. The landing page's <picture> chooses between
 * them — the phone shot below its breakpoint, the desktop one above — and a
 * browser fetches only the one it matched, never both.
 */
const IMAGES = new Map([
  ['/hero.webp', HERO_WEBP],
  ['/phone.webp', PHONE_WEBP],
]);

/**
 * The sha256 of the one inline <script> at the foot of landing.html, base64,
 * over the exact bytes between its tags. It is the whole of script-src: no
 * 'unsafe-inline', no host, nothing else can run. Change a single character
 * of that script and this string must be recomputed with it, or the browser
 * refuses the script and the copy buttons never appear — silently, but for
 * one console message. test/e2e.mjs recomputes the hash from landing.html and
 * compares it with the header served here ("the CSP hash is the sha256 of the
 * inline script"), so the two cannot drift apart unnoticed.
 */
const SCRIPT_HASH = "'sha256-C8gkazKNWkmUhWSw+06Mli7Fx69psS093xTnLFt4ack='";

/** Headers on every HTML response. The page loads one image, from itself. */
const HTML_SECURITY_HEADERS = {
  // 'self' is here for the screenshots and nothing else; the favicon is still
  // a data: URI. default-src stays 'none', so the only thing that runs is the
  // one inline script whose hash is named above.
  'content-security-policy':
    `default-src 'none'; script-src ${SCRIPT_HASH}; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // www.foray-terminal.com -> foray-terminal.com, path and query kept, so
    // there is one canonical install URL. curl -L in the one-liner follows it.
    // The target is always https: this site has no business on plain http,
    // and the redirect cannot loop because the host changes.
    const host = url.hostname.toLowerCase();
    if (host.startsWith('www.')) {
      url.hostname = host.slice(4);
      url.protocol = 'https:';
      url.port = '';
      return Response.redirect(url.toString(), 301);
    }

    const path = url.pathname;
    const known = path === '/' || path === '/install.sh' || IMAGES.has(path);
    if (!known) return notFound(method === 'HEAD');
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed();

    if (path === '/install.sh') {
      return handleInstallScript(request, env, ctx);
    }
    if (IMAGES.has(path)) {
      return screenshot(IMAGES.get(path), method === 'HEAD');
    }
    return landingPage(method === 'HEAD');
  },
};

function landingPage(isHead) {
  return new Response(isHead ? null : LANDING_HTML, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      ...HTML_SECURITY_HEADERS,
    },
  });
}

/** A screenshot from the landing page, served as its own cacheable route. */
function screenshot(bytes, isHead) {
  return new Response(isHead ? null : bytes, {
    status: 200,
    headers: {
      'content-type': 'image/webp',
      'cache-control': `public, max-age=${IMAGE_TTL_SECONDS}, s-maxage=${IMAGE_TTL_SECONDS}, immutable`,
      'x-content-type-options': 'nosniff',
    },
  });
}

function notFound(isHead) {
  const body = `Not found.\n\nforay-terminal.com serves /, /install.sh, ${[
    ...IMAGES.keys(),
  ].join(' and ')}.\n`;
  return new Response(isHead ? null : body, {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

function methodNotAllowed() {
  return new Response('Method not allowed. This site answers GET and HEAD.\n', {
    status: 405,
    headers: {
      allow: 'GET, HEAD',
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
