/**
 * 보이드(Boids) 무리 짓기 — Craig Reynolds의 3규칙 그대로.
 * 각 보이드는 이웃(perceptionRadius 안)에 대해서만:
 *   1) separation: 너무 가까운 이웃(separationRadius 안)에게서 멀어지기
 *   2) alignment:  이웃들의 평균 속도 방향으로 맞추기
 *   3) cohesion:   이웃들의 평균 위치(무리 중심) 쪽으로 끌리기
 * 이 세 조향력(steering force)만 합쳐서 가속도로 쓴다 — "무리"라는 개념 자체는 코드 어디에도
 * 없고, 각자 자기 주변만 보고 반응한 결과로 무리처럼 보이는 움직임이 나온다.
 *
 * 브라우저(<script> 태그)와 Node(require) 양쪽에서 그대로 쓸 수 있게 UMD로 감쌌다 —
 * demo.html은 이 파일 내용을 그대로 인라인하고, 테스트는 require해서 쓴다.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.Boids = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    const mag = (v) => Math.hypot(v.x, v.y);
    const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
    const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
    const scale = (v, s) => ({ x: v.x * s, y: v.y * s });
    const limit = (v, max) => {
        const m = mag(v);
        return m > max && m > 0 ? scale(v, max / m) : v;
    };
    const setMag = (v, m) => {
        const cur = mag(v);
        return cur > 0 ? scale(v, m / cur) : { x: 0, y: 0 };
    };

    class Boid {
        constructor(x, y, vx, vy) {
            this.x = x; this.y = y;
            this.vx = vx; this.vy = vy;
        }
    }

    const DEFAULTS = {
        width: 800, height: 600,
        maxSpeed: 3.2, maxForce: 0.09,
        perceptionRadius: 55, separationRadius: 22,
        separationWeight: 1.6, alignmentWeight: 1.0, cohesionWeight: 1.0,
    };

    class Flock {
        constructor(count, opts = {}) {
            this.opts = { ...DEFAULTS, ...opts };
            this.boids = Array.from({ length: count }, () => new Boid(
                Math.random() * this.opts.width,
                Math.random() * this.opts.height,
                (Math.random() - 0.5) * this.opts.maxSpeed,
                (Math.random() - 0.5) * this.opts.maxSpeed,
            ));
        }

        // 하나의 보이드가 이웃들을 보고 결정하는 조향력. 테스트하기 쉽게 Flock 밖에서도
        // 순수 함수로 호출 가능하도록 분리해뒀다(정적 메서드).
        static steerFor(boid, neighbors, opts) {
            let sepSteer = { x: 0, y: 0 }, sepCount = 0;
            let aliSum = { x: 0, y: 0 }, aliCount = 0;
            let cohSum = { x: 0, y: 0 }, cohCount = 0;

            for (const other of neighbors) {
                if (other === boid) continue;
                const d = sub(boid, other);
                const dist = mag(d);
                if (dist === 0 || dist > opts.perceptionRadius) continue;

                if (dist < opts.separationRadius) {
                    sepSteer = add(sepSteer, scale(d, 1 / dist)); // 가까울수록 더 세게 밀어냄
                    sepCount++;
                }
                aliSum = add(aliSum, { x: other.vx, y: other.vy });
                aliCount++;
                cohSum = add(cohSum, { x: other.x, y: other.y });
                cohCount++;
            }

            let separation = { x: 0, y: 0 }, alignment = { x: 0, y: 0 }, cohesion = { x: 0, y: 0 };

            if (sepCount > 0) {
                separation = limit(setMag(scale(sepSteer, 1 / sepCount), opts.maxSpeed), opts.maxForce);
            }
            if (aliCount > 0) {
                const avgVel = scale(aliSum, 1 / aliCount);
                const desired = setMag(avgVel, opts.maxSpeed);
                alignment = limit(sub(desired, { x: boid.vx, y: boid.vy }), opts.maxForce);
            }
            if (cohCount > 0) {
                const center = scale(cohSum, 1 / cohCount);
                const desired = setMag(sub(center, boid), opts.maxSpeed);
                cohesion = limit(sub(desired, { x: boid.vx, y: boid.vy }), opts.maxForce);
            }

            return add(add(scale(separation, opts.separationWeight), scale(alignment, opts.alignmentWeight)), scale(cohesion, opts.cohesionWeight));
        }

        step(repel) {
            const opts = this.opts;
            const accelerations = this.boids.map((b) => {
                let steer = Flock.steerFor(b, this.boids, opts);
                if (repel && repel.radius > 0) {
                    const d = sub(b, repel);
                    const dist = mag(d);
                    if (dist > 0 && dist < repel.radius) {
                        const push = scale(setMag(d, opts.maxSpeed), (repel.strength ?? 3) * (1 - dist / repel.radius));
                        steer = add(steer, limit(push, opts.maxForce * 6));
                    }
                }
                return steer;
            });

            this.boids.forEach((b, i) => {
                const a = accelerations[i];
                b.vx += a.x; b.vy += a.y;
                const v = limit({ x: b.vx, y: b.vy }, opts.maxSpeed);
                b.vx = v.x; b.vy = v.y;
                b.x += b.vx; b.y += b.vy;
                // 화면 가장자리에서 반대편으로 순간이동(wrap-around)
                if (b.x < 0) b.x += opts.width; else if (b.x >= opts.width) b.x -= opts.width;
                if (b.y < 0) b.y += opts.height; else if (b.y >= opts.height) b.y -= opts.height;
            });
        }
    }

    return { Flock, Boid, _vec: { mag, sub, add, scale, limit, setMag } };
});
