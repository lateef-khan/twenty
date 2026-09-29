import { type NextFunction, type Request, type Response } from 'express';

const API_PATH_PREFIXES = ['/graphql', '/metadata', '/rest', '/auth'];

// The origin is escaped so a "</script>" in it cannot end the script early.
// The same call the front's SignOut mutation makes: it ends the server session
// and clears the httpOnly twenty-session cookie. The broadcast is the one the
// front listens to, so other open CRM tabs sign out too.
const buildSignOutPage = (hubOrigin: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Signing out</title></head>
<body><script>
(async () => {
  const hub = ${JSON.stringify(hubOrigin).replace(/</g, '\\u003c')};
  let status = 'sign-out-failed';
  try {
    const response = await fetch('/metadata', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationName: 'SignOut', query: 'mutation SignOut { signOut }' }),
    });
    status = 'signed-out-' + response.status;
  } finally {
    try { new BroadcastChannel('twenty-sign-out').postMessage({ type: 'sign-out' }); } catch {}
    if (window.parent !== window) window.parent.postMessage({ type: 'hub:signed-out', app: 'crm' }, hub);
    document.body.textContent = status;
  }
})();
</script></body></html>`;

// Collapses repeated slashes, drops one trailing slash and lower-cases, so
// //welcome, /welcome/ and /Welcome match /welcome the way the front's
// router does.
const normalizePath = (path: string): string =>
  path
    .replace(/\/{2,}/g, '/')
    .replace(/(.)\/$/, '$1')
    .toLowerCase();

const isApiPath = (path: string): boolean =>
  API_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );

// Lets the Spirit Hub frame the CRM, sends a signed-out visitor to the Hub's
// sign-in, and serves the page the Hub opens to sign the CRM out.
// /welcome?local=1 still shows Twenty's own sign-in, for the back-door admin.
export const spiritHubMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  if (request.method !== 'GET') {
    return next();
  }

  const hubOrigin = process.env.SPIRIT_HUB_ORIGIN;
  const loginUrl = process.env.SPIRIT_HUB_LOGIN_URL;
  const path = normalizePath(request.path);

  // Without a hub origin only the CRM may frame itself: a missing setting
  // breaks the Hub, never the framing guard.
  if (!isApiPath(path)) {
    response.setHeader(
      'Content-Security-Policy',
      hubOrigin
        ? `frame-ancestors 'self' ${hubOrigin}`
        : "frame-ancestors 'self'",
    );
  }

  if (path === '/welcome' && loginUrl && request.query.local !== '1') {
    response.setHeader('Cache-Control', 'no-store');

    return response.redirect(302, loginUrl);
  }

  if (path === '/spirit/sign-out' && hubOrigin) {
    response.setHeader('Cache-Control', 'no-store');
    response.type('html').send(buildSignOutPage(hubOrigin));

    return;
  }

  next();
};
