/**
 * 최소 예시 서버: 그룹 생성 → 초대 → (구글 로그인으로) 수락까지 전체 흐름을 프레임워크 없이 이어붙인다.
 * 이메일 발송은 하지 않는다 — sendInvite()가 링크를 콘솔에 찍어줄 뿐이니, 실제 서비스에서는
 * 그 자리에 SMTP/메일 API 호출을 넣으면 된다.
 *
 * 사용법:
 *   GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com node demo/server-example.js
 *   그 다음 demo/dashboard.html(그룹 주인용)과 demo/accept.html(초대받은 사람용)을
 *   같은 오리진에서 서빙해서 열면 됨 (프론트가 이 서버의 API를 호출하는 구조).
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const { verifyGoogleIdToken, GoogleTokenVerificationError } = require('../../google-login/verify');
const { GroupStore, GroupInviteError } = require('../store');

const PORT = process.env.PORT || 8788;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

if (!CLIENT_ID) {
    console.log('GOOGLE_CLIENT_ID 환경변수가 없습니다.');
    process.exit(1);
}

const store = new GroupStore({ persistPath: path.join(__dirname, 'groups.json') });

// 실제로 이메일을 보내려면 여기를 SMTP/메일 API 호출로 바꾸면 됨.
const sendInvite = (invite, link) => {
    console.log(`[초대 발송 대신 콘솔에 출력] ${invite.email ?? '(누구나)'} 앞으로: ${link}`);
};

const readJsonBody = (req) => new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
});

const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
};

const requireGoogleUser = async (req) => {
    const body = await readJsonBody(req);
    if (!body.idToken) {
        const err = new Error('idToken이 필요합니다');
        err.status = 400;
        err.code = 'MISSING_ID_TOKEN';
        throw err;
    }
    const payload = await verifyGoogleIdToken(body.idToken, { clientId: CLIENT_ID });
    return { user: { sub: payload.sub, email: payload.email, name: payload.name }, body };
};

const errorStatus = (err) => {
    if (err.status) return err.status;
    if (err instanceof GoogleTokenVerificationError) return 401;
    if (err instanceof GroupInviteError) {
        return { NOT_OWNER: 403, GROUP_NOT_FOUND: 404, INVITE_NOT_FOUND: 404 }[err.code] || 400;
    }
    return 500;
};

const STATIC_DIR = __dirname;
const serveStatic = (pathname, res) => {
    const filePath = path.join(STATIC_DIR, pathname === '/' ? 'dashboard.html' : pathname);
    if (!filePath.startsWith(STATIC_DIR)) return sendJson(res, 403, { error: 'FORBIDDEN' });
    fs.readFile(filePath, (err, data) => {
        if (err) return sendJson(res, 404, { error: 'NOT_FOUND' });
        const ext = path.extname(filePath);
        const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': type });
        res.end(data);
    });
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, BASE_URL);
    try {
        if (req.method === 'GET' && url.pathname === '/config.json') {
            return sendJson(res, 200, { googleClientId: CLIENT_ID });
        }

        if (req.method === 'POST' && url.pathname === '/groups') {
            const { user, body } = await requireGoogleUser(req);
            const group = store.createGroup({ name: body.name, ownerSub: user.sub, ownerEmail: user.email, ownerName: user.name });
            return sendJson(res, 200, group);
        }

        const inviteCreateMatch = url.pathname.match(/^\/groups\/([^/]+)\/invites$/);
        if (req.method === 'POST' && inviteCreateMatch) {
            const { user, body } = await requireGoogleUser(req);
            const invite = store.createInvite({ groupId: inviteCreateMatch[1], email: body.email || null, invitedBySub: user.sub });
            const link = `${BASE_URL}/accept.html?token=${invite.token}`;
            sendInvite(invite, link);
            return sendJson(res, 200, { token: invite.token, link, expiresAt: invite.expiresAt });
        }

        const inviteGetMatch = url.pathname.match(/^\/invites\/([^/]+)$/);
        if (req.method === 'GET' && inviteGetMatch) {
            const invite = store.getInvite(inviteGetMatch[1]);
            if (!invite) return sendJson(res, 404, { error: 'INVITE_NOT_FOUND' });
            return sendJson(res, 200, { status: invite.status, groupName: invite.groupName, email: invite.email });
        }

        const inviteAcceptMatch = url.pathname.match(/^\/invites\/([^/]+)\/accept$/);
        if (req.method === 'POST' && inviteAcceptMatch) {
            const { user } = await requireGoogleUser(req);
            const group = store.acceptInvite(inviteAcceptMatch[1], user);
            return sendJson(res, 200, group);
        }

        const membersMatch = url.pathname.match(/^\/groups\/([^/]+)\/members$/);
        if (req.method === 'GET' && membersMatch) {
            return sendJson(res, 200, store.listMembers(membersMatch[1]));
        }

        if (req.method === 'GET') return serveStatic(url.pathname, res);
        return sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
        return sendJson(res, errorStatus(err), { error: err.code || 'UNKNOWN_ERROR', message: err.message });
    }
});

server.listen(PORT, () => console.log(`listening on ${BASE_URL}`));
