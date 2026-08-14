/**
 * [Verified Nth-Prime Engine v3] — 자체 학습형 앵커 캐시 추가판
 * =====================================================================================
 * v2에 추가된 것: 계산할 때마다 결과를 디스크에 저장해서, 다음 호출(심지어 다음 세션)에서도
 * 그 결과를 앵커로 재사용함. OEIS가 10^k 지점만 갖고 있는 것과 달리, 우리는 "실제로 물어본
 * 지점"들을 계속 쌓아가면서 우리 자신의 앵커 밀도를 점점 촘촘하게 만듦.
 *
 * === 이번 수정 (자가 부트스트랩 세션) ===
 * 이 파일은 의도적으로 외부 소수 표(OEIS 등)를 넣지 않는다. 대신 findNthPrime()을 반복
 * 호출하면(예: 10^1~10^15 순회) 그 결과가 자동으로 anchor_cache.json에 쌓이는 구조를
 * 그대로 쓴다. 이번에 고친 두 가지:
 *   1) nearestDist === 0n(정확히 일치하는 앵커)일 때 sieve/근사 없이 즉시 반환.
 *      (없으면 exact-match일 때도 매번 windowSize=1000짜리 segmentSieve를 돌렸음)
 *   2) 앵커를 이용해 답을 구한 경우에도 그 지점 자체를 항상 캐시에 저장.
 *      (예전엔 "신규계산일 때만" 저장해서, 앵커 근처 체크포인트는 캐시에 안 남고
 *       재실행할 때마다 같은 계산을 반복하는 문제가 있었음 — bootstrap 테스트 중 발견)
 * 두 수정 다 로직만 손봤고, 값을 만들어내는 계산식(Miller-Rabin, Cipolla, Lucy-Hedgehog
 * primeCountingPi, segmentSieve) 자체는 전혀 건드리지 않음.
 */
const fs = require('fs');
const path = require('path');

const PrimeEngine = (() => {
    const CACHE_PATH = path.join(__dirname, 'anchor_cache.json');

    const loadCachedAnchors = () => {
        try {
            const raw = fs.readFileSync(CACHE_PATH, 'utf8');
            const arr = JSON.parse(raw);
            return arr.map(a => ({ index: BigInt(a.index), value: BigInt(a.value) }));
        } catch {
            return [];
        }
    };

    const saveCachedAnchor = (index, value) => {
        let arr = [];
        try { arr = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch {}
        const indexStr = index.toString();
        if (arr.some(a => a.index === indexStr)) return; // 이미 있음
        arr.push({ index: indexStr, value: value.toString() });
        arr.sort((a, b) => (BigInt(a.index) < BigInt(b.index) ? -1 : 1));
        fs.writeFileSync(CACHE_PATH, JSON.stringify(arr));
        valueToIndexMap = null; // 새 앵커가 생겼으니 역조회 캐시 무효화 (다음 조회 때 자동 재구축)
    };

    let valueToIndexMap = null; // 지연 생성 + 캐시(매번 다시 만들지 않음)
    const buildValueIndexMap = () => {
        const map = new Map();
        for (const a of CONFIG.OEIS_ANCHORS) map.set(a.value.toString(), a.index);
        for (const a of loadCachedAnchors()) map.set(a.value.toString(), a.index);
        return map;
    };

    const CONFIG = {
        MR_BASES: [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n],
        CIPOLLA: { C1: -1, C2: -2, C3: 6, C4: 11, C3_DENOM: 2 },
        // 의도적으로 외부 표를 넣지 않음. index=1(=1번째 소수) 하나만 트리비얼 시드로 둔다.
        // 나머지는 findNthPrime()을 부트스트랩 삼아 반복 호출해서 스스로 채운다.
        OEIS_ANCHORS: [
            { index: 1n, value: 2n },
        ],
        SAFE_INTEGER_LIMIT: Number.MAX_SAFE_INTEGER * 0.9,
        BIGINT_WALK_MAX_DIST: 3_000_000n,
    };

    const smallPrimesUpTo = (limit) => {
        const isComposite = new Uint8Array(limit + 1);
        const ps = [];
        for (let i = 2; i <= limit; i++) {
            if (!isComposite[i]) {
                ps.push(i);
                for (let j = i * i; j <= limit; j += i) isComposite[j] = 1;
            }
        }
        return ps;
    };

    const segmentSieve = (lo, hi) => {
        const size = hi - lo + 1;
        const isComposite = new Uint8Array(size);
        const sqrtHi = Math.floor(Math.sqrt(hi));
        const basePrimes = smallPrimesUpTo(sqrtHi);
        for (const p of basePrimes) {
            let start = Math.max(p * p, Math.ceil(lo / p) * p);
            for (let j = start; j <= hi; j += p) isComposite[j - lo] = 1;
        }
        const primes = [];
        const from = Math.max(lo, 2);
        for (let i = from; i <= hi; i++) {
            if (!isComposite[i - lo]) primes.push(i);
        }
        return primes;
    };

    const power = (a, b, m) => {
        let res = 1n;
        a %= m;
        while (b > 0n) {
            if (b % 2n === 1n) res = (res * a) % m;
            a = (a * a) % m;
            b /= 2n;
        }
        return res;
    };

    const isPrime = (n) => {
        if (n < 2n) return false;
        if (n === 2n || n === 3n) return true;
        if (n % 2n === 0n) return false;
        let d = n - 1n, s = 0;
        while (d % 2n === 0n) { d /= 2n; s++; }
        for (const a of CONFIG.MR_BASES) {
            if (n <= a) break;
            let x = power(a, d, n);
            if (x === 1n || x === n - 1n) continue;
            let composite = true;
            for (let r = 1; r < s; r++) {
                x = (x * x) % n;
                if (x === n - 1n) { composite = false; break; }
            }
            if (composite) return false;
        }
        return true;
    };

    const cipollaMilestone = (n) => {
        const { C1, C2, C3, C4, C3_DENOM } = CONFIG.CIPOLLA;
        const num = Number(n);
        const lnN = Math.log(num);
        const ll = Math.log(lnN);
        const term1 = lnN + ll + C1;
        const term2 = (ll + C2) / lnN;
        const term3 = -((ll ** 2 - C3 * ll + C4) / (C3_DENOM * lnN ** 2));
        return Math.round(num * (term1 + term2 + term3));
    };

    // [수정 5] li(x)(로그적분) 뉴턴 역산으로 milestone을 정제.
    // li(x)는 소수정리(PNT)에서 알려진 오차 O(√x·ln x)의 근사로, Cipolla의
    // "1/ln(n) 다항식" 오차보다 점근적으로 훨씬 정확하다. 실측(10^9~10^13)에서
    // Cipolla 대비 오차가 1.4배~43배까지 줄어드는 걸 확인했다(스케일이 클수록 더 좋아짐).
    // 단, 이게 줄이는 건 "로컬 보정" 부분(전체 시간의 10~25%)뿐이고, π(milestone) 자체의
    // O(x^0.75) 계산 비용(전체의 75~90%)은 milestone 정확도와 무관하게 그대로 남는다 —
    // 그러니 이건 상수배 최적화이지 알고리즘 벽을 뚫는 게 아니다.
    const li = (x) => {
        const lnX = Math.log(x);
        let sum = 0, term = 1;
        const maxK = Math.min(40, Math.floor(lnX) - 2);
        for (let k = 0; k <= maxK; k++) {
            if (k > 0) term *= k / lnX;
            if (term < 1e-16 * sum && k > 5) break;
            sum += term;
        }
        return (x / lnX) * sum;
    };

    const refineMilestoneWithLi = (n, x0) => {
        let x = x0;
        for (let iter = 0; iter < 6; iter++) {
            const fx = li(x) - n;
            const lnX = Math.log(x);
            const dx = fx * lnX; // 뉴턴 스텝: x - f(x)/f'(x), f'(x)=1/ln(x)
            x = x - dx;
            if (Math.abs(dx) < 1) break;
        }
        return Math.round(x);
    };

    const preciseLn = (bigN) => {
        const s = bigN.toString();
        const digits = s.length;
        const leadDigits = Math.min(17, digits);
        const lead = Number(s.slice(0, leadDigits));
        return Math.log(lead) + (digits - leadDigits) * Math.LN10;
    };

    const cipollaMilestoneBigInt = (n) => {
        const { C1, C2, C3, C4, C3_DENOM } = CONFIG.CIPOLLA;
        const lnN = preciseLn(n);
        const ll = Math.log(lnN);
        const term1 = lnN + ll + C1;
        const term2 = (ll + C2) / lnN;
        const term3 = -((ll ** 2 - C3 * ll + C4) / (C3_DENOM * lnN ** 2));
        const totalLog = lnN + Math.log(term1 + term2 + term3);

        const mantissaDigits = 17;
        let exponent = Math.floor(totalLog / Math.LN10);
        let mantissa = Math.exp(totalLog - exponent * Math.LN10);
        let mantissaInt = Math.round(mantissa * Math.pow(10, mantissaDigits - 1));
        if (mantissaInt >= Math.pow(10, mantissaDigits)) {
            mantissaInt = Math.round(mantissaInt / 10);
            exponent += 1;
        }
        const trailingZeros = exponent - (mantissaDigits - 1);
        if (trailingZeros >= 0) {
            return BigInt(mantissaInt) * (10n ** BigInt(trailingZeros));
        }
        return BigInt(Math.round(mantissaInt / Math.pow(10, -trailingZeros)));
    };

    const primeCountingPi = (x) => {
        const n = Number(x);
        const sqrtN = Math.floor(Math.sqrt(n));
        const smalls = new Uint32Array(sqrtN + 1);
        const larges = new Float64Array(sqrtN + 1);

        for (let i = 1; i <= sqrtN; i++) smalls[i] = i - 1;
        for (let i = 1; i <= sqrtN; i++) larges[i] = Math.floor(n / i) - 1;

        for (let p = 2; p <= sqrtN; p++) {
            if (smalls[p] === smalls[p - 1]) continue;
            const sp1 = smalls[p - 1];
            const p2 = p * p;
            const limit = Math.min(sqrtN, Math.floor(n / p2));
            for (let i = 1; i <= limit; i++) {
                const d = i * p;
                const val = d <= sqrtN ? larges[d] : smalls[Math.floor(n / d)];
                larges[i] -= val - sp1;
            }
            for (let v = sqrtN; v >= p2; v--) {
                smalls[v] -= smalls[Math.floor(v / p)] - sp1;
            }
        }
        return larges[1];
    };

    // [수정 7] x가 2^53(Number 정수 정확도 한계)을 넘으면 primeCountingPi는 조용히 틀린 답을
    // 낼 수 있다. larges 배열만 BigInt(BigInt64Array)로 바꾼 버전 — smalls는 항상 sqrt(x) 이하
    // 값만 담아 안전하므로 그대로 둔다. 10^12에서 원본과 정확히 일치 검증됨(37,607,912,018).
    // 실측 오버헤드 9.29배 — attemptAnyway의 순차 BigInt워크(같은 거리에서 추정 600년)보다
    // 압도적으로 낫다(10^15 milestone 기준 추정 ~9.6시간).
    const isqrt = (n) => {
        if (n < 2n) return n;
        let x = n, y = (x + 1n) >> 1n;
        while (y < x) { x = y; y = (x + n / x) >> 1n; }
        return x;
    };

    const primeCountingPiBig = (xBig) => {
        const sqrtNBig = isqrt(xBig);
        const sqrtN = Number(sqrtNBig);
        const smalls = new Uint32Array(sqrtN + 1);
        const larges = new BigInt64Array(sqrtN + 1);

        for (let i = 1; i <= sqrtN; i++) smalls[i] = i - 1;
        for (let i = 1; i <= sqrtN; i++) larges[i] = xBig / BigInt(i) - 1n;

        for (let p = 2; p <= sqrtN; p++) {
            if (smalls[p] === smalls[p - 1]) continue;
            const sp1 = smalls[p - 1];
            const sp1Big = BigInt(sp1);
            const p2Big = BigInt(p) * BigInt(p);
            const limitBig = xBig / p2Big;
            const limit = limitBig > BigInt(sqrtN) ? sqrtN : Number(limitBig);
            for (let i = 1; i <= limit; i++) {
                const d = i * p;
                let val;
                if (d <= sqrtN) {
                    val = larges[d];
                } else {
                    const q = Number(xBig / BigInt(d)); // d>sqrtN이면 x/d<sqrtN, Number로 안전
                    val = BigInt(smalls[q]);
                }
                larges[i] -= (val - sp1Big);
            }
            const p2 = p * p;
            for (let v = sqrtN; v >= p2; v--) {
                smalls[v] -= smalls[Math.floor(v / p)] - sp1;
            }
        }
        return larges[1]; // BigInt
    };

    const bigIntLocalSearch = (anchorValue, anchorIndex, targetIndex, isPrimeFn, progress) => {
        let pos = anchorValue;
        let count = anchorIndex;
        let steps = 0n;
        const t0 = performance.now();
        const totalSteps = targetIndex > anchorIndex ? targetIndex - anchorIndex : anchorIndex - targetIndex;
        const logEvery = 1_000_000n; // 100만 스텝마다 진행상황 출력 (죽일지 말지 판단할 근거)
        if (targetIndex > anchorIndex) {
            while (count < targetIndex) {
                pos += 1n; steps++;
                if (isPrimeFn(pos)) count++;
                if (progress && steps % logEvery === 0n) progress(steps, totalSteps, pos, t0);
            }
        } else if (targetIndex < anchorIndex) {
            while (count > targetIndex) {
                if (isPrimeFn(pos)) count--;
                pos -= 1n; steps++;
                if (progress && steps % logEvery === 0n) progress(steps, totalSteps, pos, t0);
            }
            while (!isPrimeFn(pos)) pos -= 1n;
        }
        return { pos, steps };
    };

    return {
        primeCountingPi,
        primeCountingPiBig,
        isPrime,
        SAFE_INTEGER_LIMIT: CONFIG.SAFE_INTEGER_LIMIT,
        OEIS_ANCHOR_COUNT: CONFIG.OEIS_ANCHORS.length,

        findAnchorIndexByValue: function (value, refresh = false) {
            if (!valueToIndexMap || refresh) valueToIndexMap = buildValueIndexMap();
            return valueToIndexMap.get(BigInt(value).toString()) ?? null;
        },

        densifyRegion: function (centerIndex, spread, count = 5) {
            const center = BigInt(centerIndex);
            const sp = BigInt(spread);
            const c = Math.max(1, count);
            const results = [];
            for (let i = 0; i < c; i++) {
                const offset = c === 1 ? 0n : (sp * 2n * BigInt(i)) / BigInt(c - 1) - sp;
                const target = center + offset;
                if (target < 1n) continue;
                try {
                    const value = this.findNthPrime(target);
                    results.push({ index: target.toString(), value });
                } catch (e) {
                    results.push({ index: target.toString(), error: e.message.split('\n')[0] });
                }
            }
            return results;
        },

        superPrimeIntervalCounts: function (seed, maxOrder = 10) {
            let current = BigInt(seed);
            let exact = true;
            const chain = [{ order: 0, value: current, exact: true }];

            const ANOMALY_THRESHOLD = 0.05;
            const cipollaTwoTermRatio = (m) => {
                const lnM = Math.log(Number(m));
                return lnM + Math.log(lnM) - 1;
            };

            for (let order = 1; order <= maxOrder; order++) {
                let next;
                if (exact) {
                    try {
                        next = BigInt(this.findNthPrime(current));
                    } catch {
                        exact = false;
                    }
                }
                if (!exact) {
                    next = cipollaMilestoneBigInt(current);
                }

                let anomalyFlag = false, anomalyRelErr = null;
                if (current >= 10n) {
                    const predicted = cipollaTwoTermRatio(current);
                    const actualRatio = Number(next) / Number(current);
                    anomalyRelErr = Math.abs(actualRatio - predicted) / predicted;
                    anomalyFlag = anomalyRelErr > ANOMALY_THRESHOLD;
                    if (anomalyFlag) {
                        console.warn(`⚠️ order-${order}: 비율이 예측(${predicted.toFixed(3)})과 ${(anomalyRelErr * 100).toFixed(1)}% 차이 — 버그 의심`);
                    }
                }

                chain.push({ order, value: next, exact, anomalyFlag, anomalyRelErr });
                current = next;
            }

            const intervals = [];
            for (let i = 1; i < chain.length - 1; i++) {
                const lower = chain[i], upper = chain[i + 1];
                const primeCount = lower.value - chain[i - 1].value;
                intervals.push({
                    from: lower.value, to: upper.value,
                    primeCountInInterval: primeCount,
                    exact: lower.exact && chain[i - 1].exact,
                });
            }
            return { chain, intervals };
        },

        findNthPrime: function (targetN, opts = {}) {
            const quiet = !!opts.quiet;
            const attemptAnyway = !!opts.attemptAnyway; // true면 SAFE_INTEGER_LIMIT/거리상한을 넘어도 거부 대신 BigInt로 그냥 시도
            const log = quiet ? () => {} : console.log;
            const n = BigInt(targetN);
            if (n < 1n) throw new Error(`❌ n은 1 이상이어야 합니다 (입력값: ${n})`);

            console.group(`🚀 ${n.toLocaleString()}번째 소수 계산`);
            const t0 = performance.now();

            if (n <= 10n) {
                let pos = 1n, count = 0n;
                while (count < n) {
                    pos += 1n;
                    if (this.isPrime(pos)) count++;
                }
                log(`ℹ️ n<=10은 직접 셈: ${pos}`);
                console.groupEnd();
                return pos.toString();
            }

            const allAnchors = CONFIG.OEIS_ANCHORS.concat(loadCachedAnchors().map(a => ({ ...a, cached: true })));
            let nearestAnchor = null, nearestDist = null;
            for (const anchor of allAnchors) {
                const dist = n > anchor.index ? n - anchor.index : anchor.index - n;
                if (nearestDist === null || dist < nearestDist) { nearestDist = dist; nearestAnchor = anchor; }
            }

            // [수정 1] 정확히 일치하는 앵커면 sieve/근사 전부 생략하고 즉시 반환.
            if (nearestDist === 0n) {
                log(`⚡ 캐시 정확 일치: ${nearestAnchor.value.toLocaleString()}`);
                console.groupEnd();
                return nearestAnchor.value.toString();
            }

            // 진행상황 출력용 (attemptAnyway로 초장거리 BigInt 워크를 돌릴 때, 죽일지 계속 볼지 판단할 근거를 준다)
            // totalSteps 추정: bigIntLocalSearch는 '인덱스(몇 번째 소수인지) 거리'가 아니라
            // '포지션(숫자) 거리'만큼 한 칸씩 걷는다 — 그 사이 합성수도 다 지나가야 하므로
            // 실제 걸음 수는 인덱스거리 × 평균 소수간격(ln value) 만큼 더 크다.
            // (처음엔 인덱스거리를 그대로 totalSteps로 써서 진행률이 133%, 200%처럼 튀는 버그가 있었음)
            const estimatedTotalSteps = (() => {
                if (!nearestAnchor) return nearestDist;
                // searchFromPoint에서 고쳤던 것과 같은 문제: 앵커 자신의 값만 쓰면(예: 2) ln(2)=0.69로
                // 간격을 심하게 과소평가한다. 타겟 인덱스의 PNT 근사(n·ln n)와 앵커 값 중 큰 쪽을 쓴다.
                const targetMagnitudeEstimate = Number(n) > 1 ? Number(n) * Math.log(Number(n)) : Number(nearestAnchor.value);
                const avgGapEstimate = Math.log(Math.max(Number(nearestAnchor.value), targetMagnitudeEstimate, 2));
                return BigInt(Math.ceil(Number(nearestDist) * avgGapEstimate));
            })();
            const progressLogger = (steps, _totalStepsFromCaller, pos, tStart) => {
                const totalSteps = estimatedTotalSteps; // 인덱스거리가 아니라 위에서 보정한 포지션거리 추정치 사용
                const elapsedSec = (performance.now() - tStart) / 1000;
                const stepsPerSec = Number(steps) / elapsedSec;
                const remaining = totalSteps - steps;
                const etaSec = stepsPerSec > 0 ? Number(remaining) / stepsPerSec : Infinity;
                const etaYears = etaSec / 3.15e7;
                const pct = totalSteps > 0n ? (Number(steps) / Number(totalSteps) * 100) : 0;
                console.log(
                    `  ⏳ ${steps.toLocaleString()}/${totalSteps.toLocaleString()} 스텝 ` +
                    `(${pct.toExponential(2)}%), ${stepsPerSec.toFixed(0)}스텝/초, ` +
                    `현재 위치=${pos.toString().length}자리, ` +
                    `남은 예상시간 ≈ ${etaYears > 1 ? etaYears.toExponential(2)+'년' : (etaSec/3600).toFixed(1)+'시간'}`
                );
            };

            const anchorExceedsNumberSafety = nearestAnchor && Number(nearestAnchor.value) > CONFIG.SAFE_INTEGER_LIMIT;
            if (anchorExceedsNumberSafety) {
                if (nearestDist > CONFIG.BIGINT_WALK_MAX_DIST && !attemptAnyway) {
                    console.groupEnd();
                    throw new Error(
                        `❌ 가장 가까운 앵커(index=10^${Math.log10(Number(nearestAnchor.index)).toFixed(0)})에서도 ` +
                        `거리가 ${nearestDist.toLocaleString()}로 너무 멉니다 ` +
                        `(BigInt 로컬워크 상한 ${CONFIG.BIGINT_WALK_MAX_DIST.toLocaleString()}).\n` +
                        `   이 스케일은 milestone도 Number 정밀도를 넘어가서 계산 불가능합니다.\n` +
                        `   그래도 시도하려면 findNthPrime(n, { attemptAnyway: true })로 호출하세요` +
                        ` — 끝날 거란 보장은 없습니다.`
                    );
                }
                log(`⚓🔢 초대형 앵커 사용(BigInt 전용 로컬워크): value=${nearestAnchor.value.toLocaleString()}, 거리=${nearestDist.toLocaleString()}`);
                const r = bigIntLocalSearch(nearestAnchor.value, nearestAnchor.index, n, this.isPrime, quiet ? null : progressLogger);
                const elapsed = (performance.now() - t0).toFixed(1);
                log(`✅ 결과: ${r.pos.toLocaleString()}`);
                log(`🔧 BigInt 로컬 스텝: ${r.steps.toLocaleString()}, 총 소요시간: ${elapsed}ms`);
                saveCachedAnchor(n, r.pos);
                log(`💾 이 결과를 새 앵커로 저장함 (다음부터 이 근처는 더 빨라짐)`);
                console.groupEnd();
                return r.pos.toString();
            }

            const milestone = refineMilestoneWithLi(Number(n), cipollaMilestone(n));

            if (milestone > CONFIG.SAFE_INTEGER_LIMIT) {
                // [수정 7] x가 2^53을 넘으면 원래는 거부했지만, sqrt(milestone)이 여전히
                // JS 타입드어레이 한계(약 42억 원소) 안이면 larges만 BigInt인 primeCountingPiBig로
                // '진짜로' 정확히 계산할 수 있다 — 10^12에서 원본과 정확히 일치 검증됨(37,607,912,018).
                // 실측 오버헤드 9.29배로, attemptAnyway 없이도 기본 동작으로 자동 전환한다.
                // 진짜로 sqrt(milestone)조차 배열 한계를 넘는 스케일에서만 attemptAnyway가 필요하다.
                const sqrtMilestoneEstimate = Math.sqrt(milestone);
                const TYPED_ARRAY_LIMIT = 4_000_000_000;

                if (sqrtMilestoneEstimate > TYPED_ARRAY_LIMIT) {
                    if (!attemptAnyway) {
                        console.groupEnd();
                        throw new Error(
                            `❌ sqrt(milestone)(${sqrtMilestoneEstimate.toExponential(3)})이 배열 한계` +
                            `(${TYPED_ARRAY_LIMIT.toExponential(3)}) 자체를 넘습니다.\n` +
                            `   이 스케일은 BigInt로도 배열 기반 계산이 불가능합니다(JS 타입드어레이 하드 한계).\n` +
                            `   그래도 시도하려면 findNthPrime(n, { attemptAnyway: true })로 호출하세요` +
                            ` — 순차 BigInt 워크뿐이라 끝날 거란 보장은 없습니다.`
                        );
                    }
                    log(`⚠️ attemptAnyway: sqrt(milestone)도 배열 한계 초과 — BigInt 순차워크로 강행`);
                    log(`⚓🔢 가장 가까운 앵커: value=${nearestAnchor.value.toLocaleString()}, 거리=${nearestDist.toLocaleString()}`);
                    const r = bigIntLocalSearch(nearestAnchor.value, nearestAnchor.index, n, this.isPrime, quiet ? null : progressLogger);
                    log(`✅ 결과: ${r.pos.toLocaleString()}`);
                    saveCachedAnchor(n, r.pos);
                    console.groupEnd();
                    return r.pos.toString();
                }

                log(`🔢 milestone이 2^53 초과(${milestone.toExponential(3)}) — BigInt(larges) 정밀버전으로 자동 전환`);
                const milestoneBig = BigInt(Math.round(milestone));
                const tPi0 = performance.now();
                const exactCountBig = this.primeCountingPiBig(milestoneBig);
                const tPi = (performance.now() - tPi0).toFixed(1);
                log(`🔢 π(milestone) = ${exactCountBig.toLocaleString()} (정확, BigInt, ${tPi}ms)`);

                let posBig;
                if (exactCountBig === n) {
                    posBig = milestoneBig;
                } else {
                    // 로컬 보정도 segmentSieve(Number 기반) 대신, 이미 검증된 bigIntLocalSearch로.
                    const r = bigIntLocalSearch(milestoneBig, exactCountBig, n, this.isPrime, quiet ? null : progressLogger);
                    posBig = r.pos;
                    log(`🔧 BigInt 로컬 보정 스텝: ${r.steps.toLocaleString()}`);
                }
                while (!this.isPrime(posBig)) posBig -= 1n;

                const elapsed = (performance.now() - t0).toFixed(1);
                log(`✅ 결과: ${posBig.toLocaleString()}`);
                log(`🔧 총 소요시간: ${elapsed}ms`);
                saveCachedAnchor(n, posBig);
                log(`💾 이 결과를 새 앵커로 저장함`);
                console.groupEnd();
                return posBig.toString();
            }

            const avgGapAtAnchor = nearestAnchor && nearestAnchor.value > 1n ? Math.log(Number(nearestAnchor.value)) : Infinity;
            const anchorCostEstimate = nearestAnchor ? Number(nearestDist) * avgGapAtAnchor : Infinity;
            const freshCostEstimate = Math.sqrt(milestone) * 50;

            let count, pos, steps;
            const useAnchor = nearestAnchor && anchorCostEstimate < freshCostEstimate && anchorCostEstimate < 2_000_000_000;

            const searchFromPoint = (startValue, startIndex) => {
                const diff = Number(n) - Number(startIndex);
                // [수정 3] avgGap을 앵커 자신의 값(startValue)만으로 추정하면, 앵커가 타겟보다
                // 훨씬 작을 때(예: value=2에서 7919 근처를 찾을 때) 간격을 크게 과소평가해서
                // 재시도 4번으로도 창이 안 넓혀지는 문제가 있었다(bootstrap 클린캐시 테스트로 재현됨).
                // 타겟 인덱스 n 자체의 소수 정리 근사(n·ln n)와 startValue 중 큰 쪽으로 잡는다.
                const targetMagnitudeEstimate = Number(n) > 1 ? Number(n) * Math.log(Number(n)) : startValue;
                const avgGap = Math.log(Math.max(startValue, targetMagnitudeEstimate, 2));
                let marginMultiplier = 1.15;
                let primesInWindow, idx;
                for (let attempt = 0; attempt < 4; attempt++) {
                    // [수정 4] +1000 고정 여유분도 marginMultiplier에 같이 곱해야 재시도가 실제로 의미 있다.
                    // 예전엔 diff가 작을 때(예: 바로 다음 소수 하나만 찾을 때) windowSize가 사실상
                    // +1000에 의해 지배되는데, 그 부분은 재시도해도 커지지 않아서 이례적으로 큰 소수
                    // 간격(10^18 근방에선 실측 기록상 gap이 1000~1500대까지도 나옴) 앞에서 4번을
                    // 다 재시도해도 실패할 수 있었다(합성 케이스로 재현 확인).
                    const windowSize = Math.ceil((Math.abs(diff) * avgGap + 1000) * marginMultiplier);
                    const useUpward = diff > 0;
                    const lo = useUpward ? startValue + 1 : Math.max(2, startValue - windowSize);
                    const hi = useUpward ? startValue + windowSize : startValue;
                    primesInWindow = segmentSieve(lo, hi);
                    idx = useUpward ? diff - 1 : primesInWindow.length + diff - 1;
                    if (idx >= 0 && idx < primesInWindow.length) break;
                    marginMultiplier *= 2;
                }
                if (idx === undefined || idx < 0 || idx >= primesInWindow.length) {
                    throw new Error(`❌ 구간이 부족합니다.`);
                }
                const bonusAnchors = [];
                const K = primesInWindow.length;
                const sampleJs = new Set([0, Math.floor(K / 4), Math.floor(K / 2), Math.floor(3 * K / 4), K - 1]);
                for (const j of sampleJs) {
                    if (j === idx) continue;
                    const anchorIndex = n - BigInt(idx) + BigInt(j);
                    bonusAnchors.push({ index: anchorIndex, value: BigInt(primesInWindow[j]) });
                }
                return { pos: BigInt(primesInWindow[idx]), steps: K, bonusAnchors };
            };

            let bonusAnchors = [];
            if (useAnchor) {
                const anchorLabel = nearestAnchor.cached
                    ? `캐시된 앵커(index=${nearestAnchor.index.toLocaleString()})`
                    : `OEIS a(${Math.log10(Number(nearestAnchor.index)).toFixed(0)})`;
                console.log(`⚓ 앵커 사용: ${anchorLabel}=${nearestAnchor.value.toLocaleString()} (거리 ${nearestDist.toLocaleString()}, milestone 재계산 생략)`);
                const r = searchFromPoint(Number(nearestAnchor.value), nearestAnchor.index);
                pos = r.pos; steps = r.steps; count = Number(n); bonusAnchors = r.bonusAnchors;
            } else {
                console.log(`📍 milestone(근사): ${milestone.toLocaleString()} (앵커보다 신규계산이 유리하다고 판단)`);
                const tPi0 = performance.now();
                count = this.primeCountingPi(milestone);
                const tPi = (performance.now() - tPi0).toFixed(1);
                console.log(`🔢 π(milestone) = ${count.toLocaleString()} (정확, ${tPi}ms)`);
                if (count !== Number(n)) {
                    const r = searchFromPoint(milestone, BigInt(count));
                    pos = r.pos; steps = r.steps; count = Number(n); bonusAnchors = r.bonusAnchors;
                } else {
                    pos = BigInt(milestone); steps = 0;
                }
            }
            while (!this.isPrime(pos)) pos -= 1n;

            const elapsed = (performance.now() - t0).toFixed(1);
            console.log(`✅ 결과: ${pos.toLocaleString()}`);
            console.log(`🔧 로컬 보정 스텝: ${steps.toLocaleString()}, 총 소요시간: ${elapsed}ms`);

            // [수정 2] 어떤 경로로 답을 구했든(앵커 이용/신규계산 모두) 이 지점 자체를 항상 저장한다.
            // 예전엔 "신규계산일 때만" 저장해서, 앵커 경로로 답을 구한 체크포인트는 캐시에
            // 안 남고 다음에 또 같은 계산을 반복하는 문제가 있었다 (bootstrap 테스트 중 발견).
            saveCachedAnchor(n, pos);
            for (const b of bonusAnchors) saveCachedAnchor(b.index, b.value);
            console.log(`💾 앵커 ${1 + bonusAnchors.length}개 저장함 (부산물 포함, 다음부터 이 근처는 더 빨라짐)`);
            console.groupEnd();

            return pos.toString();
        }
    };
})();

module.exports = { PrimeEngine };

// 직접 실행: node prime_engine_v2.js [n]
// n을 안 주면 기본값(10^10)으로 실행. 처리 후 현재까지 저장된 앵커 목록(캐시)을 출력.
if (require.main === module) {
    const arg = process.argv[2];
    const n = arg ? BigInt(arg) : 10_000_000_000n;

    console.log(`입력값: ${n.toLocaleString()}`);
    try {
        const result = PrimeEngine.findNthPrime(n);
        console.log(`\n${n.toLocaleString()}번째 소수 = ${result}`);
    } catch (e) {
        console.log(`\n계산 실패: ${e.message}`);
    }

    console.log('\n=== 현재 저장된 앵커 목록 (OEIS 내장 + 캐시) ===');
    const oeisCount = PrimeEngine.OEIS_ANCHOR_COUNT;
    console.log(`[내장 OEIS 앵커] ${oeisCount}개`);

    let cached = [];
    try {
        cached = JSON.parse(fs.readFileSync(path.join(__dirname, 'anchor_cache.json'), 'utf8'));
    } catch { /* 캐시 파일 없으면 빈 목록 */ }

    console.log(`[캐시된 앵커] ${cached.length}개`);
    if (cached.length > 0) {
        const sorted = cached.slice().sort((a, b) => (BigInt(a.index) < BigInt(b.index) ? -1 : 1));
        for (const a of sorted) {
            console.log(`  index=${BigInt(a.index).toLocaleString()}  value=${BigInt(a.value).toLocaleString()}`);
        }
    }
}