// Thin wrapper around Auth0's standard OIDC endpoints - same hand-rolled
// fetch-based approach as youtube.js's Google OAuth calls, rather than
// pulling in an OIDC client library. Auth0 only ever verifies WHO someone
// is; routes/auth0.js is what decides whether that person is allowed in
// (comparing their verified email against ADMIN_EMAIL).

const AUTHORIZE_SCOPE = 'openid email';

// A real Auth0 tenant domain is always a bare hostname (e.g.
// your-tenant.us.auth0.com), never a full URL - so accepting an explicit
// scheme here (AUTH0_DOMAIN=http://localhost:5100) is unambiguous and never
// collides with real usage. Exists purely so this integration can be tested
// end-to-end against a local mock server instead of a live Auth0 tenant.
function baseUrl() {
  const configured = process.env.AUTH0_DOMAIN;
  return configured.includes('://') ? configured.replace(/\/$/, '') : `https://${configured}`;
}

function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.AUTH0_CLIENT_ID,
    redirect_uri: process.env.AUTH0_CALLBACK_URL,
    response_type: 'code',
    scope: AUTHORIZE_SCOPE,
    state,
  });
  return `${baseUrl()}/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const res = await fetch(`${baseUrl()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.AUTH0_CLIENT_ID,
      client_secret: process.env.AUTH0_CLIENT_SECRET,
      code,
      redirect_uri: process.env.AUTH0_CALLBACK_URL,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json();
}

// Calling Auth0's own /userinfo endpoint with the access token, rather than
// decoding+verifying the ID token's JWT signature locally, sidesteps
// needing a JWKS/JWT-verification library entirely - Auth0 has already done
// that verification by the time it hands back a real access token here.
async function getUserInfo(accessToken) {
  const res = await fetch(`${baseUrl()}/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Fetching user info failed: ${await res.text()}`);
  return res.json();
}

function getLogoutUrl(returnTo) {
  const params = new URLSearchParams({
    client_id: process.env.AUTH0_CLIENT_ID,
    returnTo,
  });
  return `${baseUrl()}/v2/logout?${params.toString()}`;
}

module.exports = { getAuthUrl, exchangeCodeForTokens, getUserInfo, getLogoutUrl };
