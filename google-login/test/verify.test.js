const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyGoogleIdToken, GoogleTokenVerificationError } = require('../verify');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// 실제 구글 대신, 이 테스트 안에서만 쓰는 RSA 키쌍으로 "가짜 구글"을 흉내낸다.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = KID;
jwk.alg = 'RS256';
jwk.use = 'sig';
const fakeFetchJWKS = async () => [jwk];

const signToken = (payloadOverrides = {}, { kid = KID, alg = 'RS256' } = {}) => {
    const header = { alg, typ: 'JWT', kid };
    const payload = {
        iss: 'https://accounts.google.com',
        aud: 'test-client-id.apps.googleusercontent.com',
        sub: '1234567890',
        email: 'user@example.com',
        email_verified: true,
        name: '테스트 사용자',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...payloadOverrides,
    };
    const headerB64 = b64url(Buffer.from(JSON.stringify(header)));
    const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
    const signedData = `${headerB64}.${payloadB64}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signedData), privateKey);
    return `${signedData}.${b64url(signature)}`;
};

test('유효한 토큰은 payload를 그대로 반환한다', async () => {
    const token = signToken();
    const payload = await verifyGoogleIdToken(token, {
        clientId: 'test-client-id.apps.googleusercontent.com',
        fetchJWKS: fakeFetchJWKS,
    });
    assert.equal(payload.email, 'user@example.com');
    assert.equal(payload.sub, '1234567890');
});

test('서명이 변조되면 거부한다', async () => {
    const token = signToken();
    const tampered = token.slice(0, -4) + 'abcd';
    await assert.rejects(
        () => verifyGoogleIdToken(tampered, { clientId: 'test-client-id.apps.googleusercontent.com', fetchJWKS: fakeFetchJWKS }),
        (err) => err instanceof GoogleTokenVerificationError && err.code === 'INVALID_SIGNATURE'
    );
});

test('만료된 토큰은 거부한다', async () => {
    const token = signToken({ exp: Math.floor(Date.now() / 1000) - 1000 });
    await assert.rejects(
        () => verifyGoogleIdToken(token, { clientId: 'test-client-id.apps.googleusercontent.com', fetchJWKS: fakeFetchJWKS }),
        (err) => err instanceof GoogleTokenVerificationError && err.code === 'TOKEN_EXPIRED'
    );
});

test('발급자가 구글이 아니면 거부한다', async () => {
    const token = signToken({ iss: 'https://evil.example.com' });
    await assert.rejects(
        () => verifyGoogleIdToken(token, { clientId: 'test-client-id.apps.googleusercontent.com', fetchJWKS: fakeFetchJWKS }),
        (err) => err instanceof GoogleTokenVerificationError && err.code === 'INVALID_ISSUER'
    );
});

test('클라이언트 ID(audience)가 다르면 거부한다', async () => {
    const token = signToken();
    await assert.rejects(
        () => verifyGoogleIdToken(token, { clientId: 'other-client-id.apps.googleusercontent.com', fetchJWKS: fakeFetchJWKS }),
        (err) => err instanceof GoogleTokenVerificationError && err.code === 'AUDIENCE_MISMATCH'
    );
});

test('RS256이 아닌 토큰은 거부한다', async () => {
    const header = { alg: 'none', typ: 'JWT', kid: KID };
    const payload = { iss: 'https://accounts.google.com', aud: 'test-client-id.apps.googleusercontent.com', exp: Math.floor(Date.now() / 1000) + 3600 };
    const forged = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}.`;
    await assert.rejects(
        () => verifyGoogleIdToken(forged, { clientId: 'test-client-id.apps.googleusercontent.com', fetchJWKS: fakeFetchJWKS }),
        (err) => err instanceof GoogleTokenVerificationError && err.code === 'UNSUPPORTED_ALG'
    );
});

test('알 수 없는 kid는 거부한다', async () => {
    const token = signToken({}, { kid: 'nonexistent-key' });
    await assert.rejects(
        () => verifyGoogleIdToken(token, { clientId: 'test-client-id.apps.googleusercontent.com', fetchJWKS: fakeFetchJWKS }),
        (err) => err instanceof GoogleTokenVerificationError && err.code === 'UNKNOWN_KEY_ID'
    );
});
