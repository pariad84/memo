/**
 * 최소 지정가 주문 매칭 엔진 (price-time priority)
 * 같은 가격대에서는 먼저 들어온 주문이 먼저 체결된다. 시장가 주문은 없고,
 * 상대편 호가와 가격이 겹치는(crossing) 지정가 주문만 즉시 체결되며,
 * 남은 수량은 그대로 호가창에 걸린다.
 */

class OrderBook {
    constructor(symbol = 'SIM') {
        this.symbol = symbol;
        this.bids = new Map(); // price -> Order[] (FIFO)
        this.asks = new Map();
        this.orderIndex = new Map(); // orderId -> { side, price }
        this.trades = [];
        this.nextOrderId = 1;
        this.lastTradePrice = null;
    }

    _bestPrice(map, mode) {
        let best = null;
        for (const p of map.keys()) {
            if (best === null || (mode === 'max' ? p > best : p < best)) best = p;
        }
        return best;
    }

    bestBid() { return this._bestPrice(this.bids, 'max'); }
    bestAsk() { return this._bestPrice(this.asks, 'min'); }

    midPrice() {
        const b = this.bestBid(), a = this.bestAsk();
        if (b !== null && a !== null) return (b + a) / 2;
        // 한쪽 호가만 남아있으면, 오래된 마지막 체결가보다 그 남아있는 호가 자체가 더 나은 추정치다.
        if (b !== null) return b;
        if (a !== null) return a;
        return this.lastTradePrice;
    }

    spread() {
        const b = this.bestBid(), a = this.bestAsk();
        return (b === null || a === null) ? null : a - b;
    }

    submitLimitOrder({ side, price, qty, traderId, ts = Date.now() }) {
        if (side !== 'buy' && side !== 'sell') throw new Error(`side는 'buy'/'sell'이어야 합니다: ${side}`);
        if (qty <= 0) throw new Error(`qty는 양수여야 합니다: ${qty}`);

        const orderId = this.nextOrderId++;
        const oppMap = side === 'buy' ? this.asks : this.bids;
        const crosses = (levelPrice) => side === 'buy' ? levelPrice <= price : levelPrice >= price;
        const localTrades = [];
        let remaining = qty;

        while (remaining > 0) {
            const oppPrice = this._bestPrice(oppMap, side === 'buy' ? 'min' : 'max');
            if (oppPrice === null || !crosses(oppPrice)) break;

            const queue = oppMap.get(oppPrice);
            const resting = queue[0];
            const tradeQty = Math.min(remaining, resting.qty);
            resting.qty -= tradeQty;
            remaining -= tradeQty;

            const trade = {
                id: this.trades.length + 1,
                price: oppPrice, // 체결가는 항상 먼저 걸려 있던(taker가 아닌) 주문의 가격
                qty: tradeQty,
                ts,
                takerSide: side,
                buyTrader: side === 'buy' ? traderId : resting.traderId,
                sellTrader: side === 'sell' ? traderId : resting.traderId,
            };
            this.trades.push(trade);
            localTrades.push(trade);
            this.lastTradePrice = oppPrice;

            if (resting.qty === 0) {
                queue.shift();
                this.orderIndex.delete(resting.id);
                if (queue.length === 0) oppMap.delete(oppPrice);
            }
        }

        if (remaining > 0) {
            const ownMap = side === 'buy' ? this.bids : this.asks;
            if (!ownMap.has(price)) ownMap.set(price, []);
            ownMap.get(price).push({ id: orderId, side, price, qty: remaining, traderId, ts });
            this.orderIndex.set(orderId, { side, price });
        }

        return { orderId, filledQty: qty - remaining, remainingQty: remaining, trades: localTrades };
    }

    cancelOrder(orderId) {
        const info = this.orderIndex.get(orderId);
        if (!info) return false;
        const map = info.side === 'buy' ? this.bids : this.asks;
        const queue = map.get(info.price);
        const idx = queue ? queue.findIndex(o => o.id === orderId) : -1;
        if (idx === -1) return false;
        queue.splice(idx, 1);
        if (queue.length === 0) map.delete(info.price);
        this.orderIndex.delete(orderId);
        return true;
    }

    snapshot(depth = 10) {
        const levels = (map, mode) => {
            const prices = Array.from(map.keys()).sort((a, b) => mode === 'desc' ? b - a : a - b).slice(0, depth);
            return prices.map(p => {
                const q = map.get(p);
                return { price: p, qty: q.reduce((s, o) => s + o.qty, 0), orders: q.length };
            });
        };
        return {
            bids: levels(this.bids, 'desc'),
            asks: levels(this.asks, 'asc'),
            bestBid: this.bestBid(),
            bestAsk: this.bestAsk(),
            mid: this.midPrice(),
            spread: this.spread(),
        };
    }
}

module.exports = { OrderBook };
