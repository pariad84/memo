/**
 * 무작위 트레이더 시뮬레이션.
 * 각 트레이더는 "공정가(fair value)"에 대해 서로 다른 개인 편차(bias)를 갖고,
 * 매 틱마다 일부가 깨어나 그 편차 낀 관점으로 주문을 낸다 — 그 관점 차이 자체가
 * 유동성을 만든다. 일부는 즉시 체결되도록 스프레드를 가로질러 주문하고(taker),
 * 나머지는 자기 생각 가격 근처에 지정가로 걸어둔다(maker). 개별 트레이더는
 * 아무 "지능"도 없지만, 이 단순한 규칙만으로 가격이 공정가를 따라가는 걸 볼 수 있다.
 *
 * 사용법: node simulate.js
 * 결과는 sim_results.json에 저장된다.
 */
const fs = require('fs');
const path = require('path');
const { OrderBook } = require('./matching_engine');

const CONFIG = {
    TICKS: 400,
    TRADER_COUNT: 40,
    ACTORS_PER_TICK: [2, 7], // 틱마다 이 범위에서 무작위로 몇 명이 깨어나는지
    START_PRICE: 100,
    TICK_SIZE: 0.05,
    FAIR_VALUE_VOL: 0.12, // 공정가 자체가 매 틱 흔들리는 정도 (랜덤워크)
    TRADER_BIAS_STD: 0.6, // 트레이더별 "관점 편차"의 표준편차
    TRADER_NOISE_STD: 0.25, // 매 주문마다 추가되는 잡음
    AGGRESSIVE_PROB: 0.35, // 스프레드를 가로질러 즉시 체결을 노릴 확률
    QTY_RANGE: [1, 12],
    SNAPSHOT_EVERY: 40,
};

// Box-Muller
const gaussian = () => {
    const u1 = Math.random() || 1e-12, u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};
const roundToTick = (p) => Math.round(p / CONFIG.TICK_SIZE) * CONFIG.TICK_SIZE;
const randInt = ([lo, hi]) => lo + Math.floor(Math.random() * (hi - lo + 1));

const main = () => {
    const book = new OrderBook('SIM');
    const traders = Array.from({ length: CONFIG.TRADER_COUNT }, (_, i) => ({
        id: `T${i + 1}`,
        bias: gaussian() * CONFIG.TRADER_BIAS_STD,
    }));

    let fairValue = CONFIG.START_PRICE;
    const priceHistory = [];
    const depthSnapshots = [];

    for (let tick = 0; tick < CONFIG.TICKS; tick++) {
        fairValue = Math.max(1, fairValue + gaussian() * CONFIG.FAIR_VALUE_VOL);

        const actorCount = randInt(CONFIG.ACTORS_PER_TICK);
        const actors = [...traders].sort(() => Math.random() - 0.5).slice(0, actorCount);
        let tickVolume = 0;

        for (const trader of actors) {
            const view = fairValue + trader.bias + gaussian() * CONFIG.TRADER_NOISE_STD;
            const mid = book.midPrice() ?? fairValue;
            const side = view >= mid ? 'buy' : 'sell';
            const qty = randInt(CONFIG.QTY_RANGE);
            const aggressive = Math.random() < CONFIG.AGGRESSIVE_PROB;

            let price;
            if (aggressive) {
                const opp = side === 'buy' ? book.bestAsk() : book.bestBid();
                price = opp !== null ? opp : roundToTick(view);
            } else {
                price = roundToTick(view);
            }

            const { trades } = book.submitLimitOrder({ side, price, qty, traderId: trader.id, ts: tick });
            tickVolume += trades.reduce((s, t) => s + t.qty, 0);
        }

        priceHistory.push({
            tick,
            fairValue: Number(fairValue.toFixed(4)),
            mid: book.midPrice(),
            bestBid: book.bestBid(),
            bestAsk: book.bestAsk(),
            spread: book.spread(),
            lastTrade: book.lastTradePrice,
            cumulativeTrades: book.trades.length,
            tickVolume,
        });

        if (tick % CONFIG.SNAPSHOT_EVERY === 0 || tick === CONFIG.TICKS - 1) {
            depthSnapshots.push({ tick, ...book.snapshot(12) });
        }
    }

    const totalVolume = book.trades.reduce((s, t) => s + t.qty, 0);
    const finalSnapshot = book.snapshot(12);

    console.log(`틱 ${CONFIG.TICKS}회, 트레이더 ${CONFIG.TRADER_COUNT}명 시뮬레이션 완료`);
    console.log(`  체결 건수: ${book.trades.length.toLocaleString()}건, 총 체결 수량: ${totalVolume.toLocaleString()}`);
    console.log(`  공정가: ${CONFIG.START_PRICE} → ${fairValue.toFixed(2)}`);
    console.log(`  마지막 체결가: ${book.lastTradePrice}, 최종 스프레드: ${finalSnapshot.spread}`);

    const outPath = path.join(__dirname, 'sim_results.json');
    fs.writeFileSync(outPath, JSON.stringify({
        config: CONFIG,
        generatedAt: new Date().toISOString(),
        priceHistory,
        trades: book.trades,
        depthSnapshots,
        finalSnapshot,
        summary: {
            totalTrades: book.trades.length,
            totalVolume,
            startFairValue: CONFIG.START_PRICE,
            endFairValue: Number(fairValue.toFixed(4)),
            lastTradePrice: book.lastTradePrice,
        },
    }, null, 2) + '\n');
    console.log(`결과 저장: ${path.relative(process.cwd(), outPath)}`);
};

main();
