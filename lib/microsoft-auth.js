import { createHmac, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as oidc from 'openid-client';

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const denied = () => Object.assign(new Error('This account is not authorized for the contest.'), { status: 403 });

export function microsoftSettings(env) {
  const match = /^https:\/\/login\.microsoftonline\.com\/([a-f\d-]+)\/v2\.0\/?$/i.exec(env.OIDC_ISSUER || '');
  if (env.OIDC_ISSUER && (!match || !uuid.test(match[1]))) {
    throw new Error('Use your tenant-specific Microsoft Entra issuer: https://login.microsoftonline.com/TENANT_UUID/v2.0');
  }
  if (!match || !uuid.test(env.OIDC_CLIENT_ID || '') || !env.OIDC_PRIVATE_KEY_PATH || !env.OIDC_CERT_THUMBPRINT || (env.IDENTITY_SECRET || '').length < 32) {
    throw new Error('Configure OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_PRIVATE_KEY_PATH, OIDC_CERT_THUMBPRINT and a stable IDENTITY_SECRET of at least 32 characters.');
  }
  if (env.IDENTITY_SECRET === env.SESSION_SECRET) throw new Error('IDENTITY_SECRET must differ from SESSION_SECRET.');
  if (!/^[A-Za-z0-9_-]{43}$/.test(env.OIDC_CERT_THUMBPRINT)) throw new Error('OIDC_CERT_THUMBPRINT must be the base64url SHA-256 certificate thumbprint.');
  let key;
  try {
    key = createPrivateKey(readFileSync(env.OIDC_PRIVATE_KEY_PATH));
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('key');
  } catch { throw new Error('The OIDC private key must be a readable RSA private key of at least 2048 bits.'); }
  return {
    issuer: `https://login.microsoftonline.com/${match[1].toLowerCase()}/v2.0`,
    tenant: match[1].toLowerCase(), clientId: env.OIDC_CLIENT_ID,
    privateKey: key.toCryptoKey({ name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']),
    thumbprint: env.OIDC_CERT_THUMBPRINT, identitySecret: env.IDENTITY_SECRET
  };
}

export async function microsoftClient(settings, customFetch) {
  const client = await oidc.discovery(new URL(settings.issuer), settings.clientId, {
    token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: 'PS256', id_token_signed_response_alg: 'RS256'
  }, oidc.PrivateKeyJwt(settings.privateKey, {
    [oidc.modifyAssertion]: (header, payload) => {
      header['x5t#S256'] = settings.thumbprint;
      // Entra requires the token endpoint, rather than the generic OIDC issuer, as assertion audience.
      payload.aud = settings.issuer.replace('/v2.0', '/oauth2/v2.0/token');
    }
  }), {
    timeout: 10, execute: [oidc.enableNonRepudiationChecks],
    ...(customFetch ? { [oidc.customFetch]: customFetch } : {})
  });
  const metadata = client.serverMetadata();
  if (metadata.issuer !== settings.issuer) throw new Error('Unexpected Microsoft issuer metadata.');
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    const url = new URL(metadata[field]);
    if (url.origin !== 'https://login.microsoftonline.com' || url.username || url.password) throw new Error('Unexpected Microsoft endpoint.');
  }
  return client;
}

// Called only after openid-client has verified signature, issuer, audience, expiry, nonce and PKCE.
export function contestIdentity(claims, settings) {
  if (claims.iss !== settings.issuer || claims.tid?.toLowerCase() !== settings.tenant ||
      !uuid.test(claims.oid || '') || !claims.sub || claims.acct !== 0 ||
      !Array.isArray(claims.roles) || !claims.roles.includes('Contest.Participant')) throw denied();
  const digest = createHmac('sha256', settings.identitySecret)
    .update(JSON.stringify([settings.tenant, claims.oid.toLowerCase()])).digest('hex');
  return { id: `u1:${digest}`, name: `Home cook ${digest.slice(0, 8).toUpperCase()}` };
}
