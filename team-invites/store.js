/**
 * 그룹/초대 저장소 — 외부 의존성 없이 순수 Node로. 기본은 JSON 파일에 저장(primes/anchor_cache.json과
 * 같은 방식: 생성자에서 한 번 읽고, 바뀔 때마다 통째로 다시 씀)하고, persistPath를 안 주면 메모리에만
 * 둔다. 실 서비스에선 이 클래스를 진짜 DB 백엔드로 바꿔 끼우면 된다 — 바깥에 노출하는 메서드 시그니처만
 * 유지하면 됨.
 *
 * 흐름: 그룹 주인이 createInvite()로 토큰을 받아 초대 링크를 전달(이메일/메신저 등, 이 모듈은 전송 자체는
 * 하지 않음) → 초대받은 사람이 그 토큰으로 acceptInvite()를 호출(구글 로그인으로 신원 확인 후)하면 멤버가 됨.
 */
const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class GroupInviteError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'GroupInviteError';
        this.code = code;
    }
}

const genId = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');
const now = () => Date.now();

class GroupStore {
    constructor({ persistPath = null } = {}) {
        this.persistPath = persistPath;
        this.groups = new Map();  // groupId -> { id, name, ownerSub, members: Map<sub, Member>, createdAt }
        this.invites = new Map(); // token -> Invite
        this._load();
    }

    _load() {
        if (!this.persistPath) return;
        try {
            const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
            for (const g of raw.groups || []) {
                this.groups.set(g.id, { ...g, members: new Map(g.members.map((m) => [m.sub, m])) });
            }
            for (const inv of raw.invites || []) this.invites.set(inv.token, inv);
        } catch {
            // 파일이 없거나 처음 실행하는 경우 — 빈 상태로 시작
        }
    }

    _save() {
        if (!this.persistPath) return;
        const groups = [...this.groups.values()].map((g) => ({ ...g, members: [...g.members.values()] }));
        const invites = [...this.invites.values()];
        fs.writeFileSync(this.persistPath, JSON.stringify({ groups, invites }, null, 2) + '\n');
    }

    _serializeGroup(group) {
        return { id: group.id, name: group.name, ownerSub: group.ownerSub, createdAt: group.createdAt, members: [...group.members.values()] };
    }

    createGroup({ name, ownerSub, ownerEmail, ownerName }) {
        if (!name || !ownerSub) throw new GroupInviteError('INVALID_ARGS', 'name과 ownerSub는 필수입니다');
        const id = genId(9);
        const group = {
            id, name, ownerSub, createdAt: now(),
            members: new Map([[ownerSub, { sub: ownerSub, email: ownerEmail, name: ownerName, role: 'owner', joinedAt: now() }]]),
        };
        this.groups.set(id, group);
        this._save();
        return this._serializeGroup(group);
    }

    getGroup(groupId) {
        const g = this.groups.get(groupId);
        return g ? this._serializeGroup(g) : null;
    }

    createInvite({ groupId, email = null, invitedBySub, ttlMs = DEFAULT_TTL_MS }) {
        const group = this.groups.get(groupId);
        if (!group) throw new GroupInviteError('GROUP_NOT_FOUND', `그룹을 찾을 수 없습니다: ${groupId}`);
        if (group.ownerSub !== invitedBySub) throw new GroupInviteError('NOT_OWNER', '그룹 주인만 초대를 만들 수 있습니다');

        const token = genId(24);
        const invite = {
            token, groupId, email, invitedBySub,
            status: 'pending', createdAt: now(), expiresAt: now() + ttlMs,
            acceptedBySub: null, acceptedAt: null,
        };
        this.invites.set(token, invite);
        this._save();
        return { ...invite };
    }

    // 실제 status(pending/expired/accepted/revoked)를 저장값 그대로가 아니라 현재 시각 기준으로 계산해서 준다.
    getInvite(token) {
        const invite = this.invites.get(token);
        if (!invite) return null;
        const status = invite.status === 'pending' && now() > invite.expiresAt ? 'expired' : invite.status;
        const group = this.groups.get(invite.groupId);
        return { ...invite, status, groupName: group ? group.name : null };
    }

    revokeInvite(token, revokedBySub) {
        const invite = this.invites.get(token);
        if (!invite) throw new GroupInviteError('INVITE_NOT_FOUND', '초대를 찾을 수 없습니다');
        const group = this.groups.get(invite.groupId);
        if (!group || group.ownerSub !== revokedBySub) throw new GroupInviteError('NOT_OWNER', '그룹 주인만 초대를 취소할 수 있습니다');
        invite.status = 'revoked';
        this._save();
        return { ...invite };
    }

    acceptInvite(token, { sub, email, name }) {
        const invite = this.invites.get(token);
        if (!invite) throw new GroupInviteError('INVITE_NOT_FOUND', '초대를 찾을 수 없습니다');
        if (invite.status === 'revoked') throw new GroupInviteError('INVITE_REVOKED', '취소된 초대입니다');
        if (invite.status === 'accepted') throw new GroupInviteError('INVITE_ALREADY_ACCEPTED', '이미 수락된 초대입니다');
        if (now() > invite.expiresAt) throw new GroupInviteError('INVITE_EXPIRED', '만료된 초대입니다');
        if (invite.email && invite.email.toLowerCase() !== String(email).toLowerCase()) {
            throw new GroupInviteError('EMAIL_MISMATCH', `이 초대는 ${invite.email} 앞으로 보낸 것입니다`);
        }
        const group = this.groups.get(invite.groupId);
        if (!group) throw new GroupInviteError('GROUP_NOT_FOUND', '그룹을 찾을 수 없습니다');

        group.members.set(sub, { sub, email, name, role: 'member', joinedAt: now() });
        invite.status = 'accepted';
        invite.acceptedBySub = sub;
        invite.acceptedAt = now();
        this._save();
        return this._serializeGroup(group);
    }

    listMembers(groupId) {
        const group = this.groups.get(groupId);
        if (!group) throw new GroupInviteError('GROUP_NOT_FOUND', '그룹을 찾을 수 없습니다');
        return [...group.members.values()];
    }
}

module.exports = { GroupStore, GroupInviteError };
