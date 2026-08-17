/**
 * 최소 예시: 프레임워크 없이 Node 내장 http만으로 idToken을 받아 검증하는 엔드포인트 +
 * index.html을 서빙(파일을 file://로 직접 열면 Google 로그인 버튼이 안 뜨므로 반드시 서버로 열 것).
 * 클라이언트 ID는 GOOGLE_CLIENT_ID 환경변수 하나로만 관리하고, /config.json으로 프론트에 내려준다
 * — index.html에 직접 박아넣지 않으니 나중에 클라이언트 ID가 바뀌어도 코드를 안 고쳐도 됨.
 *
 * 사용법:
 *   GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com node demo/server-example.js
 *   http://localhost:8787 접속
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
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

const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
};

const serveFile = (res, filePath, contentType) => {
    fs.readFile(filePath, (err, data) => {
        if (err) return sendJson(res, 404, { error: 'NOT_FOUND' });
        res.writeHead(200, { 'content-type': contentType });
        res.end(data);
    });
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return serveFile(res, path.join(__dirname, 'index.html'), 'text/html');
    }
    if (req.method === 'GET' && url.pathname === '/config.json') {
        return sendJson(res, 200, { googleClientId: CLIENT_ID });
    }

    if (req.method === 'POST' && url.pathname === '/auth/google') {
        let body;
        try {
            body = await readJsonBody(req);
        } catch {
            return sendJson(res, 400, { error: 'INVALID_JSON' });
        }
        try {
            const user = await verifyGoogleIdToken(body.idToken, { clientId: CLIENT_ID });
            return sendJson(res, 200, {
                sub: user.sub,
                email: user.email,
                emailVerified: user.email_verified,
                name: user.name,
                picture: user.picture,
            });
        } catch (err) {
            const code = err instanceof GoogleTokenVerificationError ? err.code : 'UNKNOWN_ERROR';
            return sendJson(res, 401, { error: code, message: err.message });
        }
    }

    return sendJson(res, 404, { error: 'NOT_FOUND' });
});

server.listen(PORT, () => console.log(`listening on http://localhost:${PORT}`));
