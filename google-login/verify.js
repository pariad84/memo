/**
 * 구글 ID 토큰(JWT) 검증기 — 프레임워크/외부 의존성 없이 Node 내장 crypto만 사용.
 * 프론트엔드의 Google Identity Services 버튼(https://accounts.google.com/gsi/client)이
 * 로그인 성공 시 넘겨주는 credential(ID 토큰)을, 이 모듈로 서명·발급자·대상(audience)·
 * 만료를 검증해서 신뢰할 수 있는 사용자 정보(payload)로 바꿔준다.
 *
 * 사용법:
 *   const { verifyGoogleIdToken } = require('./verify');
 *   const payload = await verifyGoogleIdToken(idToken, { clientId: 'xxx.apps.googleusercontent.com' });
 *   // payload.sub, payload.email, payload.name, payload.picture ...
 */
const crypto = require('crypto');

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const CLOCK_SKEW_SEC = 60; // exp/iat 판정에 허용할 시계 오차

class GoogleTokenVerificationError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'GoogleTokenVerificationError';
        this.code = code;
    }
}

const b64urlToBuffer = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64urlToJSON = (s) => JSON.parse(b64urlToBuffer(s).toString('utf8'));

let jwksCache = { keys: null, expiresAt: 0 };

// 실제 사용 시에는 기본값(진짜 구글 JWKS)을 쓰고, 테스트에서는 fetcher를 주입해서
// 네트워크 없이 검증 로직만 독립적으로 확인할 수 있게 한다.
const defaultFetchJWKS = async () => {
    const res = await fetch(GOOGLE_JWKS_URL);
    if (!res.ok) throw new GoogleTokenVerificationError('JWKS_FETCH_FAILED', `JWKS 요청 실패: HTTP ${res.status}`);
    const body = await res.json();
    return body.keys;
};

const getSigningKey = async (kid, { fetchJWKS = defaultFetchJWKS, now = Date.now() } = {}) => {
    if (!jwksCache.keys || now >= jwksCache.expiresAt) {
        jwksCache = { keys: await fetchJWKS(), expiresAt: now + 60 * 60 * 1000 }; // 1시간 캐시
    }
    const jwk = jwksCache.keys.find((k) => k.kid === kid);
    if (!jwk) {
        // 구글이 키를 막 회전시켰을 수 있으니, 캐시를 버리고 한 번만 다시 시도한다.
        jwksCache = { keys: await fetchJWKS(), expiresAt: now + 60 * 60 * 1000 };
        const retried = jwksCache.keys.find((k) => k.kid === kid);
        if (!retried) throw new GoogleTokenVerificationError('UNKNOWN_KEY_ID', `일치하는 서명 키를 찾을 수 없습니다 (kid=${kid})`);
        return retried;
    }
    return jwk;
};

/**
 * @param {string} idToken - Google Identity Services가 발급한 ID 토큰(JWT)
 * @param {object} opts
 * @param {string} [opts.clientId] - 이 값과 토큰의 aud가 일치해야 함 (없으면 audience 검증 생략)
 * @param {string[]} [opts.allowedClientIds] - 여러 클라이언트 ID를 허용해야 할 때 clientId 대신 사용
 * @param {function} [opts.fetchJWKS] - 테스트용 JWKS fetcher 주입 지점
 * @param {number} [opts.now] - 테스트용 현재시각(ms) 주입 지점
 * @returns {Promise<object>} 검증된 토큰 payload
 */
async function verifyGoogleIdToken(idToken, opts = {}) {
    const { clientId, allowedClientIds, fetchJWKS = defaultFetchJWKS, now = Date.now() } = opts;

    if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
        throw new GoogleTokenVerificationError('MALFORMED_TOKEN', 'ID 토큰 형식이 아닙니다 (header.payload.signature 형태여야 함)');
    }
    const [headerB64, payloadB64, sigB64] = idToken.split('.');

    let header, payload;
    try {
        header = b64urlToJSON(headerB64);
        payload = b64urlToJSON(payloadB64);
    } catch {
        throw new GoogleTokenVerificationError('MALFORMED_TOKEN', 'header/payload를 파싱할 수 없습니다');
    }

    if (header.alg !== 'RS256') {
        throw new GoogleTokenVerificationError('UNSUPPORTED_ALG', `지원하지 않는 알고리즘입니다: ${header.alg}`);
    }

    const jwk = await getSigningKey(header.kid, { fetchJWKS, now });
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const signedData = `${headerB64}.${payloadB64}`;
    const signatureValid = crypto.verify('RSA-SHA256', Buffer.from(signedData), publicKey, b64urlToBuffer(sigB64));
    if (!signatureValid) {
        throw new GoogleTokenVerificationError('INVALID_SIGNATURE', '서명 검증에 실패했습니다 (위조되었거나 손상된 토큰)');
    }

    if (!GOOGLE_ISSUERS.has(payload.iss)) {
        throw new GoogleTokenVerificationError('INVALID_ISSUER', `발급자가 구글이 아닙니다: ${payload.iss}`);
    }

    const nowSec = now / 1000;
    if (payload.exp == null || nowSec > payload.exp + CLOCK_SKEW_SEC) {
        throw new GoogleTokenVerificationError('TOKEN_EXPIRED', '토큰이 만료되었습니다');
    }
    if (payload.iat != null && nowSec < payload.iat - CLOCK_SKEW_SEC) {
        throw new GoogleTokenVerificationError('TOKEN_NOT_YET_VALID', '토큰의 발급 시각이 미래입니다');
    }

    const expectedAudiences = allowedClientIds ?? (clientId ? [clientId] : null);
    if (expectedAudiences && !expectedAudiences.includes(payload.aud)) {
        throw new GoogleTokenVerificationError('AUDIENCE_MISMATCH', `대상(aud)이 이 앱의 클라이언트 ID와 일치하지 않습니다: ${payload.aud}`);
    }

    return payload;
}

module.exports = { verifyGoogleIdToken, GoogleTokenVerificationError, GOOGLE_JWKS_URL };
