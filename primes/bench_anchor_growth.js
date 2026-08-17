/**
 * [앵커 캐시 성장 벤치마크]
 * =====================================================================================
 * primes.js의 findNthPrime()은 호출할 때마다 결과를 anchor_cache.json에 저장해서,
 * 같은 구간을 다시 물어볼 때 훨씬 빠르게 답하도록 설계되어 있다. 이 스크립트는 그 효과를
 * 실측해서 보여준다: 서로 다른 규모(10^6 ~ 10^10)의 "구간(band)"을 하나씩 잡고, 그 구간
 * 안에서 무작위 인덱스를 반복해서 물어보면서 각 질의에 걸린 시간을 기록한다. 앵커가
 * 쌓일수록(=캐시 밀도가 올라갈수록) 질의 시간이 짧아지는 걸 그래프로 확인할 수 있다.
 *
 * 사용법:
 *   node bench_anchor_growth.js            누적 캐시 그대로 이어서 실행
 *   node bench_anchor_growth.js --fresh    anchor_cache.json을 비우고 콜드 스타트부터 측정
 *
 * 결과는 bench_results.json에 저장된다 (band별 질의 로그 + 요약).
 */
const fs = require('fs');
const path = require('path');
const { PrimeEngine } = require('./primes.js');

const CACHE_PATH = path.join(__dirname, 'anchor_cache.json');
const RESULTS_PATH = path.join(__dirname, 'bench_results.json');

const BANDS = [
    { label: '10^6', base: 1_000_000n, width: 200_000n, queries: 20 },
    { label: '10^9', base: 1_000_000_000n, width: 5_000_000n, queries: 25 },
    { label: '10^10', base: 10_000_000_000n, width: 20_000_000n, queries: 20 },
    { label: '10^12', base: 1_000_000_000_000n, width: 50_000_000n, queries: 6 },
];

const readCacheAnchors = () => {
    try {
        const raw = fs.readFileSync(CACHE_PATH, 'utf8');
        return JSON.parse(raw).map(a => ({ index: BigInt(a.index), value: BigInt(a.value) }));
    } catch {
        return [];
    }
};

// 중복 없는 무작위 오프셋(셔플된 정수 수열)을 뽑는다 — 같은 지점을 두 번 질의하면
// 두 번째는 항상 "정확 일치"라 캐시 성장 곡선이 아니라 그냥 순간응답만 재는 꼴이 된다.
const shuffledOffsets = (width, count) => {
    const span = Number(width);
    const step = Math.max(1, Math.floor(span / count));
    const offsets = [];
    for (let i = 0; i < count; i++) offsets.push(i * step + Math.floor(Math.random() * step));
    for (let i = offsets.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [offsets[i], offsets[j]] = [offsets[j], offsets[i]];
    }
    return offsets;
};

const runBand = (band) => {
    const offsets = shuffledOffsets(band.width, band.queries);
    const queries = [];
    console.log(`\n[${band.label} 구간] base=${band.base.toLocaleString()}, width=${band.width.toLocaleString()}, 질의 ${band.queries}회`);
    for (let i = 0; i < offsets.length; i++) {
        const target = band.base + BigInt(offsets[i]);
        const before = readCacheAnchors().filter(a => a.index >= band.base && a.index <= band.base + band.width).length;
        const t0 = performance.now();
        PrimeEngine.findNthPrime(target, { quiet: true });
        const elapsedMs = performance.now() - t0;
        queries.push({ order: i, target: target.toString(), elapsedMs, localAnchorsBefore: before });
        console.log(`  #${i + 1}/${offsets.length}  ${elapsedMs.toFixed(1)}ms  (질의 전 이 구간 내 앵커 ${before}개)`);
    }
    return queries;
};

const summarize = (label, queries) => {
    const n = queries.length;
    const half = Math.max(1, Math.floor(n / 2));
    const avg = (arr) => arr.reduce((s, q) => s + q.elapsedMs, 0) / arr.length;
    const firstHalf = avg(queries.slice(0, half));
    const secondHalf = avg(queries.slice(n - half));
    return {
        label,
        queries: n,
        avgFirstHalfMs: firstHalf,
        avgSecondHalfMs: secondHalf,
        speedup: firstHalf / Math.max(secondHalf, 0.001),
    };
};

const main = () => {
    const fresh = process.argv.includes('--fresh');
    if (fresh) {
        fs.rmSync(CACHE_PATH, { force: true });
        console.log('--fresh: anchor_cache.json을 비우고 콜드 스타트부터 시작합니다.');
    }

    const results = {};
    const summaries = [];
    for (const band of BANDS) {
        const queries = runBand(band);
        results[band.label] = queries;
        const summary = summarize(band.label, queries);
        summaries.push(summary);
    }

    console.log('\n=== 요약: 구간 전반부 평균 vs 후반부 평균 ===');
    for (const s of summaries) {
        console.log(
            `${s.label.padEnd(6)}  전반부 ${s.avgFirstHalfMs.toFixed(1).padStart(8)}ms` +
            `  →  후반부 ${s.avgSecondHalfMs.toFixed(1).padStart(8)}ms` +
            `  (${s.speedup.toFixed(1)}배 빨라짐)`
        );
    }

    fs.writeFileSync(RESULTS_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), bands: results, summaries }, null, 2) + '\n');
    console.log(`\n결과 저장: ${path.relative(process.cwd(), RESULTS_PATH)}`);
};

main();
