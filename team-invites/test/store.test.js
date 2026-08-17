const test = require('node:test');
const assert = require('node:assert/strict');
const { GroupStore, GroupInviteError } = require('../store');

const owner = { sub: 'owner-1', email: 'owner@example.com', name: '주인장' };
const invitee = { sub: 'invitee-1', email: 'friend@example.com', name: '친구' };

const setupGroup = () => {
    const store = new GroupStore(); // persistPath 없음 -> 메모리에만
    const group = store.createGroup({ name: '테스트 그룹', ownerSub: owner.sub, ownerEmail: owner.email, ownerName: owner.name });
    return { store, group };
};

test('그룹을 만들면 주인이 첫 멤버로 들어간다', () => {
    const { group } = setupGroup();
    assert.equal(group.members.length, 1);
    assert.equal(group.members[0].sub, owner.sub);
    assert.equal(group.members[0].role, 'owner');
});

test('초대를 수락하면 멤버로 추가된다', () => {
    const { store, group } = setupGroup();
    const invite = store.createInvite({ groupId: group.id, email: invitee.email, invitedBySub: owner.sub });
    const updated = store.acceptInvite(invite.token, invitee);
    assert.equal(updated.members.length, 2);
    assert.ok(updated.members.some((m) => m.sub === invitee.sub && m.role === 'member'));
    assert.equal(store.getInvite(invite.token).status, 'accepted');
});

test('이메일 지정 없는 오픈 링크는 아무나 수락 가능', () => {
    const { store, group } = setupGroup();
    const invite = store.createInvite({ groupId: group.id, invitedBySub: owner.sub }); // email 없음
    const updated = store.acceptInvite(invite.token, invitee);
    assert.ok(updated.members.some((m) => m.sub === invitee.sub));
});

test('초대받은 이메일과 로그인한 이메일이 다르면 거부', () => {
    const { store, group } = setupGroup();
    const invite = store.createInvite({ groupId: group.id, email: 'only-this@example.com', invitedBySub: owner.sub });
    assert.throws(
        () => store.acceptInvite(invite.token, invitee),
        (err) => err instanceof GroupInviteError && err.code === 'EMAIL_MISMATCH'
    );
});

test('같은 초대를 두 번 수락할 수 없다', () => {
    const { store, group } = setupGroup();
    const invite = store.createInvite({ groupId: group.id, email: invitee.email, invitedBySub: owner.sub });
    store.acceptInvite(invite.token, invitee);
    assert.throws(
        () => store.acceptInvite(invite.token, invitee),
        (err) => err instanceof GroupInviteError && err.code === 'INVITE_ALREADY_ACCEPTED'
    );
});

test('만료된 초대는 수락할 수 없다', () => {
    const { store, group } = setupGroup();
    const invite = store.createInvite({ groupId: group.id, email: invitee.email, invitedBySub: owner.sub, ttlMs: -1 });
    assert.throws(
        () => store.acceptInvite(invite.token, invitee),
        (err) => err instanceof GroupInviteError && err.code === 'INVITE_EXPIRED'
    );
    assert.equal(store.getInvite(invite.token).status, 'expired');
});

test('취소된 초대는 수락할 수 없다', () => {
    const { store, group } = setupGroup();
    const invite = store.createInvite({ groupId: group.id, email: invitee.email, invitedBySub: owner.sub });
    store.revokeInvite(invite.token, owner.sub);
    assert.throws(
        () => store.acceptInvite(invite.token, invitee),
        (err) => err instanceof GroupInviteError && err.code === 'INVITE_REVOKED'
    );
});

test('그룹 주인이 아니면 초대를 만들 수 없다', () => {
    const { store, group } = setupGroup();
    assert.throws(
        () => store.createInvite({ groupId: group.id, email: invitee.email, invitedBySub: invitee.sub }),
        (err) => err instanceof GroupInviteError && err.code === 'NOT_OWNER'
    );
});

test('그룹 주인이 아니면 초대를 취소할 수 없다', () => {
    const { store, group } = setupGroup();
    const invite = store.createInvite({ groupId: group.id, email: invitee.email, invitedBySub: owner.sub });
    assert.throws(
        () => store.revokeInvite(invite.token, invitee.sub),
        (err) => err instanceof GroupInviteError && err.code === 'NOT_OWNER'
    );
});

test('JSON 파일에 저장하면 새 인스턴스에서도 이어서 읽힌다', () => {
    const os = require('os'), path = require('path');
    const file = path.join(os.tmpdir(), `group-store-test-${Date.now()}.json`);
    const store1 = new GroupStore({ persistPath: file });
    const group = store1.createGroup({ name: '영속 그룹', ownerSub: owner.sub, ownerEmail: owner.email, ownerName: owner.name });
    store1.createInvite({ groupId: group.id, email: invitee.email, invitedBySub: owner.sub });

    const store2 = new GroupStore({ persistPath: file });
    assert.equal(store2.getGroup(group.id).name, '영속 그룹');
    assert.equal(store2.listMembers(group.id).length, 1);
    require('fs').unlinkSync(file);
});
