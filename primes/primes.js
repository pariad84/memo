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

    const bigIntLocalSearch = (anchorValue, anchorIndex, targetIndex, isPrimeFn) => {
        let pos = anchorValue;
        let count = anchorIndex;
        let steps = 0n;
        if (targetIndex > anchorIndex) {
            while (count < targetIndex) {
                pos += 1n; steps++;
                if (isPrimeFn(pos)) count++;
            }
        } else if (targetIndex < anchorIndex) {
            while (count > targetIndex) {
                if (isPrimeFn(pos)) count--;
                pos -= 1n; steps++;
            }
            while (!isPrimeFn(pos)) pos -= 1n;
        }
        return { pos, steps };
    };

    return {
        primeCountingPi,
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

        findNthPrime: function (targetN) {
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
                console.log(`ℹ️ n<=10은 직접 셈: ${pos}`);
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
            // (이게 없으면 exact-match일 때도 매번 windowSize=1000짜리 segmentSieve를 돌렸음)
            if (nearestDist === 0n) {
                console.log(`⚡ 캐시 정확 일치: ${nearestAnchor.value.toLocaleString()}`);
                console.groupEnd();
                return nearestAnchor.value.toString();
            }

            const anchorExceedsNumberSafety = nearestAnchor && Number(nearestAnchor.value) > CONFIG.SAFE_INTEGER_LIMIT;
            if (anchorExceedsNumberSafety) {
                if (nearestDist > CONFIG.BIGINT_WALK_MAX_DIST) {
                    console.groupEnd();
                    throw new Error(
                        `❌ 가장 가까운 앵커(index=10^${Math.log10(Number(nearestAnchor.index)).toFixed(0)})에서도 ` +
                        `거리가 ${nearestDist.toLocaleString()}로 너무 멉니다 ` +
                        `(BigInt 로컬워크 상한 ${CONFIG.BIGINT_WALK_MAX_DIST.toLocaleString()}).\n` +
                        `   이 스케일은 milestone도 Number 정밀도를 넘어가서 계산 불가능합니다.`
                    );
                }
                console.log(`⚓🔢 초대형 앵커 사용(BigInt 전용 로컬워크): value=${nearestAnchor.value.toLocaleString()}, 거리=${nearestDist.toLocaleString()}`);
                const r = bigIntLocalSearch(nearestAnchor.value, nearestAnchor.index, n, this.isPrime);
                const elapsed = (performance.now() - t0).toFixed(1);
                console.log(`✅ 결과: ${r.pos.toLocaleString()}`);
                console.log(`🔧 BigInt 로컬 스텝: ${r.steps.toLocaleString()}, 총 소요시간: ${elapsed}ms`);
                saveCachedAnchor(n, r.pos);
                console.log(`💾 이 결과를 새 앵커로 저장함 (다음부터 이 근처는 더 빨라짐)`);
                console.groupEnd();
                return r.pos.toString();
            }

            const milestone = cipollaMilestone(n);

            if (milestone > CONFIG.SAFE_INTEGER_LIMIT) {
                console.groupEnd();
                throw new Error(
                    `❌ milestone(${milestone.toExponential(3)})이 안전 한계` +
                    `(${CONFIG.SAFE_INTEGER_LIMIT.toExponential(3)})를 초과합니다.\n` +
                    `   이 엔진은 내부적으로 Number(double)를 쓰기 때문에 이 스케일에서는\n` +
                    `   정수 연산이 깨져 틀린 답을 낼 수 있습니다. n을 줄이거나,\n` +
                    `   가까운 초대형 앵커가 있는지 확인하세요.`
                );
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
                    const windowSize = Math.ceil(Math.abs(diff) * avgGap * marginMultiplier) + 1000000000;
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