/**
 * 최소 예시: 프레임워크 없이 Node 내장 http만으로 idToken을 받아 검증하는 엔드포인트.
 * 실제 앱에서는 이 자리에 세션 생성/JWT 발급 등을 붙이면 된다.
 *
 * 사용법:
 *   GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com node demo/server-example.js
 *   curl -X POST http://localhost:8787/auth/google -H 'content-type: application/json' \
 *        -d '{"idToken":"<demo/index.html에서 받은 idToken>"}'
 */
const http = require('http');
const { verifyGoogleIdToken, GoogleTokenVerificationError } = require('../verify');

const PORT = process.env.PORT || 8787;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

if (!CLIENT_ID) {
    console.log('GOOGLE_CLIENT_ID 환경변수가 없습니다. 예: GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com node demo/server-example.js');
    process.exit(1);
}

const readJsonBody = (req) => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/auth/google') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'INVALID_JSON' }));
        }

        try {
            const user = await verifyGoogleIdToken(body.idToken, { clientId: CLIENT_ID });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
                sub: user.sub,
                email: user.email,
                emailVerified: user.email_verified,
                name: user.name,
                picture: user.picture,
            }));
        } catch (err) {
            const code = err instanceof GoogleTokenVerificationError ? err.code : 'UNKNOWN_ERROR';
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: code, message: err.message }));
        }
        return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
});

server.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));
