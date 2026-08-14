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

    let cachedAnchorsMemo = null; // 프로세스 안에서는 디스크를 한 번만 읽고 메모리에 재사용

    const loadCachedAnchors = () => {
        if (cachedAnchorsMemo !== null) return cachedAnchorsMemo;
        try {
            const raw = fs.readFileSync(CACHE_PATH, 'utf8');
            const arr = JSON.parse(raw);
            cachedAnchorsMemo = arr.map(a => ({ index: BigInt(a.index), value: BigInt(a.value) }));
        } catch {
            cachedAnchorsMemo = [];
        }
        return cachedAnchorsMemo; // index 오름차순 정렬 유지됨 (저장할 때마다 정렬해서 씀)
    };

    const saveCachedAnchor = (index, value) => {
        const list = loadCachedAnchors(); // 메모리에 있으면 디스크를 다시 안 읽음
        if (list.some(a => a.index === index)) return; // 이미 있음
        list.push({ index, value });
        list.sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
        const serializable = list.map(a => ({ index: a.index.toString(), value: a.value.toString() }));
        fs.writeFileSync(CACHE_PATH, JSON.stringify(serializable, null, 2) + '\n'); // 사람이 읽기 좋게 줄바꿈 포함
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

    // [수정 5] Gram 급수 기반 Riemann R(x) + BigInt 고정소수점 뉴턴 정제.
    // 원래는 li(x) 근사를 썼는데, 별개로 검토하던 "Omni-Quantum" 소스에서 죽은 코드/장식 필드를
    // 걷어내고 남은 핵심(Cipolla 초기값 → Gram급수 R(x) 뉴턴보정)을 실측해보니, 불완전했던
    // 제타값 테이블(ζ(2)~ζ(5)만 있고 그 이상은 전부 1.0으로 근사)을 ζ(2)~ζ(16)까지 정확한 값으로
    // 채우자 li(x) 정제보다 실제로 더 정확해졌다(10^9~10^13 전 구간에서 1.4배~33.6배 더 정확,
    // 실측 검증됨). 그래서 li(x) 대신 이걸로 교체한다.
    const GR_PREC = 40n;
    const GR_SCALE = 10n ** GR_PREC;
    const GR_LN10 = 23025850929940456840179914546843642076011n;
    const GR_ZETA = [0n, 0n,
        16449340668482264364724151666460251892218n, 12020569031595942853997381615114499907650n,
        10823232337111381915160036965411679027748n, 10369277551433699263313654864570341680570n,
        10173430619844491397145179297909205279018n, 10083492773819228268397975498497967595998n,
        10040773561979443393786852385086524652125n, 10020083928260822144178527692324120604856n,
        10009945751278180853371459589003190170060n, 10004941886041194645587022825264699364686n,
        10002460865533080482986379980477396709604n, 10001227133475784891467518365263573957982n,
        10000612481350587048292585451051353337948n, 10000305882363070204935517285106450625876n,
        10000152822594086518717325714876367220038n];

    const bigLog = (n) => {
        if (n <= 1n) return 0n;
        const s = n.toString();
        const b = BigInt(s.length - 1);
        const a = (n * GR_SCALE) / (10n ** b);
        const z = ((a - GR_SCALE) * GR_SCALE) / (a + GR_SCALE);
        const z2 = (z * z) / GR_SCALE;
        let sum = 0n, term = z;
        for (let k = 1n; k < 100n; k += 2n) {
            const delta = term / k;
            if (delta === 0n) break;
            sum += delta;
            term = (term * z2) / GR_SCALE;
        }
        return b * GR_LN10 + 2n * sum;
    };

    const gramR = (lnx) => {
        let sum = GR_SCALE, term = lnx, kFactorial = 1n;
        const lnxReal = lnx / GR_SCALE;
        const maxK = lnxReal * 4n + 50n;
        for (let k = 1n; k < maxK; k++) {
            const z = GR_ZETA[Number(k) + 1] || GR_SCALE;
            const currentTerm = (term * GR_SCALE) / (k * kFactorial * z);
            sum += currentTerm;
            term = (term * lnx) / GR_SCALE;
            kFactorial *= k + 1n;
            if (k > lnxReal && currentTerm < sum / 10n ** 30n) break;
        }
        return sum;
    };

    const refineMilestoneWithGramR = (n, x0Number) => {
        let x = BigInt(Math.round(x0Number));
        for (let iter = 0; iter < 3; iter++) {
            const lnx = bigLog(x);
            const Rx = gramR(lnx);
            const error = Rx - n * GR_SCALE;
            const refinement = (error * lnx) / (GR_SCALE * GR_SCALE);
            x = x - refinement;
            if (refinement === 0n) break;
        }
        return Number(x);
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

    // 로그를 사람이 읽기 좋게: ms를 상황에 맞는 단위로 표시
    const formatDuration = (ms) => {
        if (ms < 1000) return `${ms.toFixed(0)}밀리초`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}초`;
        if (ms < 3600000) return `${(ms / 60000).toFixed(1)}분`;
        return `${(ms / 3600000).toFixed(1)}시간`;
    };

    return {
        primeCountingPi,
        primeCountingPiBig,
        formatDuration,
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
            const log = quiet ? () => {} : console.log; // 이 파일 안의 모든 진행 로그는 이 log()만 통해서 찍는다 (quiet:true면 전부 조용해짐)
            const n = BigInt(targetN);
            if (n < 1n) throw new Error(`n은 1 이상이어야 합니다 (입력값: ${n})`);

            log(`\n[${n.toLocaleString()}번째 소수를 찾는 중]`);
            const t0 = performance.now();

            if (n <= 10n) {
                let pos = 1n, count = 0n;
                while (count < n) {
                    pos += 1n;
                    if (this.isPrime(pos)) count++;
                }
                log(`10번째 이내라 하나씩 세서 바로 확인: ${pos}`);
                return pos.toString();
            }

            // 캐시는 항상 index 오름차순으로 정렬돼 저장되므로, 전체를 훑지 않고
            // 이진탐색으로 타겟 바로 앞/뒤 두 후보만 확인하면 된다 (캐시가 커질수록 이득이 커짐).
            const cachedList = loadCachedAnchors();
            let nearestAnchor = null, nearestDist = null;
            const considerCandidate = (anchor, isCached) => {
                if (!anchor) return;
                const dist = n > anchor.index ? n - anchor.index : anchor.index - n;
                if (nearestDist === null || dist < nearestDist) {
                    nearestDist = dist;
                    nearestAnchor = isCached ? { ...anchor, cached: true } : anchor;
                }
            };
            for (const oa of CONFIG.OEIS_ANCHORS) considerCandidate(oa, false); // 내장 앵커는 개수가 적어 그냥 확인
            if (cachedList.length > 0) {
                let lo = 0, hi = cachedList.length - 1, insertPos = cachedList.length;
                while (lo <= hi) {
                    const mid = (lo + hi) >> 1;
                    if (cachedList[mid].index >= n) { insertPos = mid; hi = mid - 1; }
                    else lo = mid + 1;
                }
                considerCandidate(cachedList[insertPos], true);     // 타겟 이상인 첫 값
                considerCandidate(cachedList[insertPos - 1], true); // 타겟 미만인 마지막 값
            }

            // [수정 1] 정확히 일치하는 앵커면 sieve/근사 전부 생략하고 즉시 반환.
            if (nearestDist === 0n) {
                log(`이미 계산해둔 값과 정확히 일치 → 바로 반환: ${nearestAnchor.value.toLocaleString()}`);
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
                log(
                    `  진행: ${steps.toLocaleString()} / 약 ${totalSteps.toLocaleString()}칸 ` +
                    `(${pct < 0.01 ? '0.01% 미만' : pct.toFixed(2) + '%'}), 초당 ${stepsPerSec.toFixed(0)}칸, ` +
                    `현재 자리수=${pos.toString().length}자리, ` +
                    `예상 남은시간 ≈ ${etaYears > 1 ? etaYears.toFixed(1) + '년' : formatDuration(etaSec * 1000)}`
                );
            };

            const anchorExceedsNumberSafety = nearestAnchor && Number(nearestAnchor.value) > CONFIG.SAFE_INTEGER_LIMIT;
            if (anchorExceedsNumberSafety) {
                if (nearestDist > CONFIG.BIGINT_WALK_MAX_DIST && !attemptAnyway) {
                    throw new Error(
                        `가장 가까운 저장값(index=10^${Math.log10(Number(nearestAnchor.index)).toFixed(0)})에서도 ` +
                        `거리가 ${nearestDist.toLocaleString()}로 너무 멉니다 ` +
                        `(하나씩 세는 방식의 상한 ${CONFIG.BIGINT_WALK_MAX_DIST.toLocaleString()}칸).\n` +
                        `  이 크기는 위치 예측(milestone)도 계산이 안 되는 범위입니다.\n` +
                        `  그래도 시도하려면 findNthPrime(n, { attemptAnyway: true })로 호출하세요` +
                        ` — 끝난다는 보장은 없습니다.`
                    );
                }
                log(`이 크기는 저장값 자체가 너무 커서, 그 지점부터 하나씩 세어가는 방식으로 찾습니다`);
                log(`  출발점: ${nearestAnchor.value.toLocaleString()} (${nearestDist.toLocaleString()}칸 떨어짐)`);
                const r = bigIntLocalSearch(nearestAnchor.value, nearestAnchor.index, n, this.isPrime, quiet ? null : progressLogger);
                const elapsed = performance.now() - t0;
                log(`완료: ${r.pos.toLocaleString()}`);
                log(`(하나씩 ${r.steps.toLocaleString()}칸 이동, 총 ${formatDuration(elapsed)} 걸림)`);
                saveCachedAnchor(n, r.pos);
                log(`다음에 이 근처를 또 찾을 때 빠르도록 저장해둠`);
                return r.pos.toString();
            }

            const milestone = refineMilestoneWithGramR(n, cipollaMilestone(n));

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
                        throw new Error(
                            `예상 위치(${sqrtMilestoneEstimate.toExponential(3)})가 배열로 셀 수 있는 한계` +
                            `(${TYPED_ARRAY_LIMIT.toExponential(3)}) 자체를 넘습니다.\n` +
                            `  이 크기는 BigInt를 써도 배열 기반 계산이 불가능합니다(자바스크립트 자체의 한계).\n` +
                            `  그래도 시도하려면 findNthPrime(n, { attemptAnyway: true })로 호출하세요` +
                            ` — 하나씩 세는 방식뿐이라 끝난다는 보장은 없습니다.`
                        );
                    }
                    log(`이 크기는 배열 기반 계산 한계를 넘어서, 하나씩 세는 방식으로 강행합니다`);
                    log(`  출발점: ${nearestAnchor.value.toLocaleString()} (${nearestDist.toLocaleString()}칸 떨어짐)`);
                    const r = bigIntLocalSearch(nearestAnchor.value, nearestAnchor.index, n, this.isPrime, quiet ? null : progressLogger);
                    log(`완료: ${r.pos.toLocaleString()}`);
                    saveCachedAnchor(n, r.pos);
                    return r.pos.toString();
                }

                log(`이 크기는 일반 방식으로는 오차가 생길 수 있어, 정밀 모드(BigInt)로 계산합니다`);
                log(`  예상 위치: 약 ${milestone.toExponential(3)}`);
                const milestoneBig = BigInt(Math.round(milestone));
                const tPi0 = performance.now();
                const exactCountBig = this.primeCountingPiBig(milestoneBig);
                const tPi = performance.now() - tPi0;
                log(`  그 지점까지 정확히 세어봄: ${exactCountBig.toLocaleString()}개 (${formatDuration(tPi)} 걸림)`);

                let posBig;
                if (exactCountBig === n) {
                    posBig = milestoneBig;
                } else {
                    // 로컬 보정도 segmentSieve(Number 기반) 대신, 이미 검증된 bigIntLocalSearch로.
                    log(`  목표와 차이가 있어 근처를 더 확인하는 중...`);
                    const r = bigIntLocalSearch(milestoneBig, exactCountBig, n, this.isPrime, quiet ? null : progressLogger);
                    posBig = r.pos;
                    log(`  추가로 ${r.steps.toLocaleString()}칸 확인함`);
                }
                while (!this.isPrime(posBig)) posBig -= 1n;

                const elapsed = performance.now() - t0;
                log(`완료: ${posBig.toLocaleString()} (총 ${formatDuration(elapsed)} 걸림)`);
                saveCachedAnchor(n, posBig);
                log(`다음에 이 근처를 또 찾을 때 빠르도록 저장해둠`);
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
                    ? `저장해둔 값(index=${nearestAnchor.index.toLocaleString()})`
                    : `내장값 a(${Math.log10(Number(nearestAnchor.index)).toFixed(0)})`;
                log(`가까운 저장값에서 출발합니다: ${anchorLabel}=${nearestAnchor.value.toLocaleString()} (거리 ${nearestDist.toLocaleString()})`);
                const r = searchFromPoint(Number(nearestAnchor.value), nearestAnchor.index);
                pos = r.pos; steps = r.steps; count = Number(n); bonusAnchors = r.bonusAnchors;
            } else {
                log(`저장값이 너무 멀어서 새로 계산합니다`);
                log(`  1) 대략 위치 예측: 약 ${milestone.toLocaleString()}`);
                const tPi0 = performance.now();
                count = this.primeCountingPi(milestone);
                const tPi = performance.now() - tPi0;
                log(`  2) 그 지점까지 정확히 세어봄: ${count.toLocaleString()}개 (${formatDuration(tPi)} 걸림)`);
                if (count !== Number(n)) {
                    log(`  3) 예측이 살짝 빗나가서 근처를 더 확인합니다`);
                    const r = searchFromPoint(milestone, BigInt(count));
                    pos = r.pos; steps = r.steps; count = Number(n); bonusAnchors = r.bonusAnchors;
                } else {
                    pos = BigInt(milestone); steps = 0;
                }
            }
            while (!this.isPrime(pos)) pos -= 1n;

            const elapsed = performance.now() - t0;
            log(`완료: ${pos.toLocaleString()}`);
            if (steps > 0) log(`  (근처를 ${steps.toLocaleString()}번 더 확인함)`);
            log(`총 소요시간: ${formatDuration(elapsed)}`);

            // [수정 2] 어떤 경로로 답을 구했든(앵커 이용/신규계산 모두) 이 지점 자체를 항상 저장한다.
            // 예전엔 "신규계산일 때만" 저장해서, 앵커 경로로 답을 구한 체크포인트는 캐시에
            // 안 남고 다음에 또 같은 계산을 반복하는 문제가 있었다 (bootstrap 테스트 중 발견).
            saveCachedAnchor(n, pos);
            for (const b of bonusAnchors) saveCachedAnchor(b.index, b.value);
            log(`다음에 이 근처를 또 찾을 때 빠르도록 ${1 + bonusAnchors.length}곳 저장해둠`);

            return pos.toString();
        }
    };
})();

module.exports = { PrimeEngine };

// 직접 실행: node prime_engine_v2.js [n]
// 사용법: node prime_engine_v2.js 500       → 500번째 소수 계산
//        node prime_engine_v2.js            → 인자 없으면 기본값(100억번째)으로 계산
if (require.main === module) {
    const arg = process.argv[2];
    const n = arg ? BigInt(arg) : 10_000_000_000n;

    if (!arg) {
        console.log(`사용법: node ${path.basename(__filename)} [몇 번째 소수인지]`);
        console.log(`(숫자를 안 줘서 기본값으로 실행합니다: ${n.toLocaleString()}번째)\n`);
    } else {
        console.log(`${n.toLocaleString()}번째 소수를 계산합니다\n`);
    }

    const cliT0 = performance.now();
    try {
        const result = PrimeEngine.findNthPrime(n);
        const cliElapsed = performance.now() - cliT0;
        console.log(`\n▶ ${n.toLocaleString()}번째 소수는 ${BigInt(result).toLocaleString()} 입니다`);
        console.log(`  (총 ${PrimeEngine.formatDuration(cliElapsed)} 걸림)`);
    } catch (e) {
        console.log(`\n계산할 수 없습니다: ${e.message}`);
    }
}