/**
 * GET /install.sh — the target of
 *
 *     curl -fsSL https://foray-terminal.com/install.sh | bash
 *
 * The script is proxied from GitHub rather than bundled here, so the site can
 * never serve a stale installer: whatever is on `main` is what people run.
 *
 * Everything in this file exists to guarantee one property: a 200 response
 * carries the whole, real installer, or there is no 200 at all. What comes out
 * of this endpoint is piped straight into a shell, so a truncated body or a
 * GitHub error page rendered with a 200 would be *executed*. The rules:
 *
 *   1. The upstream body is read to the end into memory before anything is
 *      sent downstream. A connection that dies mid-transfer rejects here and
 *      becomes a 502 — it cannot become a short 200.
 *   2. The body is checked before it is served: non-empty, a `#!` shebang,
 *      no HTML, a sane size. GitHub has been known to answer with an HTML
 *      error page and a 200 status.
 *   3. Failures are 502, never 200, so `curl -f` fails and pipes nothing into
 *      bash. The failure body is *also* written so that it is harmless if it
 *      somehow reaches a shell anyway (a caller who dropped `-f`): every line
 *      is a comment, and the last line is `exit 1`.
 *   4. Only a validated 200 is ever put in the cache.
 */

/** Where the installer really lives. The one URL that matters in this worker. */
export const UPSTREAM_URL =
  'https://raw.githubusercontent.com/cushmachine/foray-terminal/main/install.sh';

/**
 * How long a validated script sits in the edge cache. See the report/README:
 * long enough that a burst of installs collapses to ~1 GitHub fetch per
 * location per 5 minutes, short enough that a fix pushed to `main` reaches
 * everyone within 5 minutes of it landing.
 */
export const EDGE_TTL_SECONDS = 300;

/** What a client (or an intermediate proxy) may hold onto. Shorter than the edge. */
export const BROWSER_TTL_SECONDS = 60;

/** install.sh is ~22 KB today. Anything past this is not our installer. */
const MAX_SCRIPT_BYTES = 512 * 1024;

/**
 * How long to wait on GitHub before giving up. A GitHub that hangs would
 * otherwise leave `curl ... | bash` sitting there; failing at ten seconds
 * tells the caller something is wrong while they are still watching.
 */
const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * The cache key is a fixed URL, not the incoming request: apex and www, HEAD
 * and GET, and any query string all share one entry.
 */
const CACHE_KEY_URL = 'https://foray-terminal.com/install.sh';

const SCRIPT_CONTENT_TYPE = 'text/x-shellscript; charset=utf-8';

/**
 * Serve the installer. `env.INSTALL_UPSTREAM_URL`, if set, overrides the
 * upstream — used by the local tests, and a way to pin the site to a tag.
 */
export async function handleInstallScript(request, env, ctx) {
  const isHead = request.method === 'HEAD';
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(CACHE_KEY_URL, { method: 'GET' });

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return isHead ? headOf(hit) : hit;
  }

  const upstreamUrl = env?.INSTALL_UPSTREAM_URL || UPSTREAM_URL;
  let script;
  try {
    const upstream = await fetch(upstreamUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: {
        accept: 'text/plain, */*',
        'user-agent': 'foray-terminal.com install.sh proxy',
      },
    });
    if (upstream.status !== 200) {
      return failure(`GitHub answered ${upstream.status}`, isHead);
    }
    const contentType = upstream.headers.get('content-type') || '';
    if (/^text\/html/i.test(contentType)) {
      return failure('GitHub answered with a web page, not the script', isHead);
    }
    // Read to the end here. If the transfer is cut short this throws, and a
    // short read can never be mistaken for the whole script.
    script = await upstream.text();
  } catch {
    return failure('GitHub could not be reached', isHead);
  }

  const problem = checkScript(script);
  if (problem) return failure(problem, isHead);

  const response = scriptResponse(script);
  if (cache && ctx?.waitUntil) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return isHead ? headOf(response) : response;
}

/**
 * Does this look like our installer? Returns a reason to refuse, or null.
 * Exported so the tests can hit every branch without a network.
 */
export function checkScript(script) {
  if (typeof script !== 'string' || script.length === 0) {
    return 'GitHub returned an empty file';
  }
  const bytes = new TextEncoder().encode(script).length;
  if (bytes > MAX_SCRIPT_BYTES) {
    return `the file is ${bytes} bytes, which is not the installer`;
  }
  if (!script.startsWith('#!')) {
    return 'the file does not start with a #! line';
  }
  if (/<!doctype html|<html[\s>]/i.test(script.slice(0, 4096))) {
    return 'the file looks like HTML, not a shell script';
  }
  return null;
}

function scriptResponse(script) {
  return new Response(script, {
    status: 200,
    headers: {
      'content-type': SCRIPT_CONTENT_TYPE,
      // max-age is what a browser or proxy holds; s-maxage is the edge TTL,
      // which is also the TTL cache.put() stores this response under.
      'cache-control': `public, max-age=${BROWSER_TTL_SECONDS}, s-maxage=${EDGE_TTL_SECONDS}`,
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * The error path. 502 so `curl -f` fails and bash is handed nothing; a body
 * that is inert even if a shell does get it.
 */
export function failure(reason, isHead = false) {
  const body =
    `# Foray: could not serve install.sh — ${reason}.\n` +
    '# Nothing has been installed. Try again in a minute, or run the\n' +
    '# installer straight from the repository:\n' +
    `#   curl -fsSL ${UPSTREAM_URL} | bash\n` +
    'exit 1\n';
  return new Response(isHead ? null : body, {
    status: 502,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** The same headers and status as `response`, with no body, for HEAD. */
function headOf(response) {
  return new Response(null, { status: response.status, headers: response.headers });
}
