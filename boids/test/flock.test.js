const test = require('node:test');
const assert = require('node:assert/strict');
const { Flock, Boid, _vec } = require('../flock');

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test('보이드가 하나뿐이면 조향력이 0이다 (이웃이 없으므로)', () => {
    const flock = new Flock(1, { width: 200, height: 200 });
    const before = { ...flock.boids[0] };
    flock.step();
    const b = flock.boids[0];
    assert.ok(Math.abs(b.vx - before.vx) < 1e-9);
    assert.ok(Math.abs(b.vy - before.vy) < 1e-9);
});

test('속도는 maxSpeed를 넘지 않는다', () => {
    const flock = new Flock(40, { width: 300, height: 300, maxSpeed: 2 });
    for (let i = 0; i < 50; i++) flock.step();
    for (const b of flock.boids) {
        assert.ok(_vec.mag({ x: b.vx, y: b.vy }) <= 2 + 1e-6);
    }
});

test('경계를 넘으면 반대편으로 wrap된다', () => {
    const flock = new Flock(1, { width: 100, height: 100 });
    flock.boids[0].x = 99; flock.boids[0].y = 50;
    flock.boids[0].vx = 5; flock.boids[0].vy = 0;
    flock.step();
    assert.ok(flock.boids[0].x < 100 && flock.boids[0].x >= 0);
});

test('separation: 너무 가까운 두 보이드는 서로 멀어지는 방향으로 힘을 받는다', () => {
    const opts = { width: 500, height: 500, perceptionRadius: 55, separationRadius: 22, separationWeight: 2, alignmentWeight: 0, cohesionWeight: 0, maxSpeed: 3, maxForce: 5 };
    const a = new Boid(100, 100, 0, 0);
    const b = new Boid(105, 100, 0, 0); // 5px 거리, separationRadius(22)보다 훨씬 가까움
    const steerA = Flock.steerFor(a, [a, b], opts);
    // a는 b(오른쪽)에서 멀어져야 하니 x방향으로 음(-)의 힘을 받아야 함
    assert.ok(steerA.x < 0);
});

test('cohesion: 무리에서 떨어진 보이드는 무리 중심 쪽으로 끌린다', () => {
    const opts = { width: 500, height: 500, perceptionRadius: 200, separationRadius: 5, separationWeight: 0, alignmentWeight: 0, cohesionWeight: 2, maxSpeed: 3, maxForce: 5 };
    const lonely = new Boid(0, 0, 0, 0);
    const clusterA = new Boid(100, 0, 1, 0);
    const clusterB = new Boid(100, 5, -1, 0);
    const clusterC = new Boid(100, -5, 0, 1);
    const steer = Flock.steerFor(lonely, [lonely, clusterA, clusterB, clusterC], opts);
    // 무리 중심은 (100,0) 방향 -> lonely는 +x 방향으로 끌려야 함
    assert.ok(steer.x > 0);
});

test('alignment: 이웃들과 속도 방향이 다르면 그 평균 쪽으로 힘을 받는다', () => {
    const opts = { width: 500, height: 500, perceptionRadius: 200, separationRadius: 0, separationWeight: 0, alignmentWeight: 2, cohesionWeight: 0, maxSpeed: 3, maxForce: 5 };
    const odd = new Boid(50, 50, 0, 3); // 아래쪽(+y)으로 이동 중
    const n1 = new Boid(60, 50, 3, 0); // 다른 이웃들은 오른쪽(+x)으로 이동 중
    const n2 = new Boid(40, 50, 3, 0);
    const steer = Flock.steerFor(odd, [odd, n1, n2], opts);
    assert.ok(steer.x > 0); // odd도 +x 방향으로 당겨져야 함
});

test('전체 시뮬레이션을 여러 스텝 돌려도 NaN/Infinity가 생기지 않는다', () => {
    const flock = new Flock(60, { width: 400, height: 300 });
    for (let i = 0; i < 200; i++) flock.step({ x: 200, y: 150, radius: 80, strength: 4 });
    for (const b of flock.boids) {
        assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
        assert.ok(Number.isFinite(b.vx) && Number.isFinite(b.vy));
    }
});
