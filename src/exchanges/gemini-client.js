const { EventEmitter } = require("events");
const Trade = require("../trade");
const Level2Point = require("../level2-point");
const Level2Snapshot = require("../level2-snapshot");
const Level2Update = require("../level2-update");
const SmartWss = require("../smart-wss");

class TickerCache {
  constructor({ ask, bid, last, timestamp, market } = {}) {
    this.ask = ask;
    this.bid = bid;
    this.last = last;
    this.timestamp = timestamp;
    this.market = market;
  }
  setAsk(aks) {
    this.ask = aks;
    return this;
  }
  setBid(bid) {
    this.bid = bid;
    return this;
  }
  setLast(last) {
    this.last = last;
    return this;
  }
  setTimestamp(timestamp) {
    this.timestamp = timestamp;
    return this;
  }
  getTicker() {
    return {
      ask: this.ask,
      bid: this.bid,
      last: this.last,
      timestamp: this.timestamp,
      base: this.market.base,
      quote: this.market.quote
    };
  }
}
class GeminiClient extends EventEmitter {
  constructor() {
    super();
    this._name = "Gemini";
    this._subscriptions = new Map();
    this.reconnectIntervalMs = 30 * 1000;
    this.tickersCache = {}; // key-value pairs of <market_id>: TickerCache
    this.topOfBookIndicator = '-top_of_book';

    this.hasTickers = true;
    this.hasTrades = true;
    this.hasCandles = false;
    this.hasLevel2Snapshots = false;
    this.hasLevel2Updates = true;
    this.hasLevel3Snapshots = false;
    this.hasLevel3Updates = false;
  }

  reconnect() {
    for (let subscription of this._subscriptions.values()) {
      this._reconnect(subscription);
    }
  }

  subscribeTrades(market) {
    this._subscribe(market, "trades");
  }

  unsubscribeTrades(market) {
    this._unsubscribe(market, "trades");
  }

  subscribeLevel2Updates(market) {
    this._subscribe(market, "level2updates");
  }

  unsubscribeLevel2Updates(market) {
    this._unsubscribe(market, "level2updates");
  }

  subscribeTicker(market) {
    this._subscribe(market, "tickers", true);
  }

  unsubscribeTicker(market) {
    this._unsubscribe(market, "tickers", true);
  }

  close() {
    this._close();
  }

  ////////////////////////////////////////////
  // PROTECTED

  _subscribe(market, mode, top_of_book = false) {
    let remote_id = market.id.toLowerCase();
    if (top_of_book) {
      remote_id += this.topOfBookIndicator;
      // since we want to allow both top_of_book and regular (non top_of_book) subscriptions, we 
      // will add a special indicator to the remote id of subscriptions that have top_of_book
      // set to true. we can remove the special indicator when constructing URLs/paths
    }
    let subscription = this._subscriptions.get(remote_id);

    if (subscription && subscription[mode]) return;

    if (!subscription) {
      subscription = {
        market,
        wss: this._connect(remote_id),
        lastMessage: undefined,
        reconnectIntervalHandle: undefined,
        remoteId: remote_id,
        trades: false,
        level2Updates: false,
        tickers: false,
        topOfBook: top_of_book
      };

      this._startReconnectWatcher(subscription);
      this._subscriptions.set(remote_id, subscription);
    }

    subscription[mode] = true;
  }

  _unsubscribe(market, mode, top_of_book = false) {
    let remote_id = market.id.toLowerCase();
    if (top_of_book) {
      remote_id += this.topOfBookIndicator;
    }
    let subscription = this._subscriptions.get(remote_id);

    if (!subscription) return;

    subscription[mode] = false;
    if (!subscription.trades && !subscription.level2updates) {
      this._close(this._subscriptions.get(remote_id));
      this._subscriptions.delete(remote_id);
    }
    if (mode === 'tickers') {
      delete this.tickersCache[market.id];
    }
  }

  /** Connect to the websocket stream by constructing a path from
   * the subscribed markets.
   */
  _connect(remote_id) {
    const istopOfBook = remote_id.indexOf('top_of_book') !== -1;
    let wssPath = "wss://api.gemini.com/v1/marketdata/" + remote_id.replace(this.topOfBookIndicator, '') + "?heartbeat=true";
    if (istopOfBook) {
      wssPath += '&top_of_book=true';
    }
    let wss = new SmartWss(wssPath);
    wss.on("error", err => this._onError(remote_id, err));
    wss.on("connecting", () => this._onConnecting(remote_id));
    wss.on("connected", () => this._onConnected(remote_id));
    wss.on("disconnected", () => this._onDisconnected(remote_id));
    wss.on("closing", () => this._onClosing(remote_id));
    wss.on("closed", () => this._onClosed(remote_id));
    wss.on("message", raw => {
      try {
        this._onMessage(remote_id, raw);
      } catch (err) {
        this._onError(remote_id, err);
      }
    });
    wss.connect();
    return wss;
  }

  /**
   * Handles an error
   */
  _onError(remote_id, err) {
    this.emit("error", err, remote_id);
  }

  /**
   * Fires when a socket is connecting
   */
  _onConnecting(remote_id) {
    this.emit("connecting", remote_id);
  }

  /**
   * Fires when connected
   */
  _onConnected(remote_id) {
    let subscription = this._subscriptions.get(remote_id);
    if (!subscription) {
      return;
    }
    this._startReconnectWatcher(subscription);
    this.emit("connected", remote_id);
  }

  /**
   * Fires when there is a disconnection event
   */
  _onDisconnected(remote_id) {
    this._stopReconnectWatcher(this._subscriptions.get(remote_id));
    this.emit("disconnected", remote_id);
  }

  /**
   * Fires when the underlying socket is closing
   */
  _onClosing(remote_id) {
    this._stopReconnectWatcher(this._subscriptions.get(remote_id));
    this.emit("closing", remote_id);
  }

  /**
   * Fires when the underlying socket has closed
   */
  _onClosed(remote_id) {
    this.emit("closed", remote_id);
  }

  /**
   * Close the underlying connction, which provides a way to reset the things
   */
  _close(subscription) {
    if (subscription && subscription.wss) {
      try {
        subscription.wss.close();
      } catch (ex) {
        if (ex.message === "WebSocket was closed before the connection was established") return;
        this.emit("error", ex);
      }
      subscription.wss = undefined;
      this._stopReconnectWatcher(subscription);
    } else {
      this._subscriptions.forEach(sub => this._close(sub));
      this._subscriptions = new Map();
    }
  }

  /**
   * Reconnects the socket
   */
  _reconnect(subscription) {
    this.emit("reconnecting", subscription.remoteId);
    subscription.wss.once("closed", () => {
      subscription.wss = this._connect(subscription.remoteId);
    });
    this._close(subscription);
  }

  /**
   * Starts an interval to check if a reconnction is required
   */
  _startReconnectWatcher(subscription) {
    this._stopReconnectWatcher(subscription); // always clear the prior interval
    subscription.reconnectIntervalHandle = setInterval(
      () => this._onReconnectCheck(subscription),
      this.reconnectIntervalMs
    );
  }

  /**
   * Stops an interval to check if a reconnection is required
   */
  _stopReconnectWatcher(subscription) {
    if (subscription) {
      clearInterval(subscription.reconnectIntervalHandle);
      subscription.reconnectIntervalHandle = undefined;
    }
  }

  /**
   * Checks if a reconnecton is required by comparing the current
   * date to the last receieved message date
   */
  _onReconnectCheck(subscription) {
    if (
      !subscription.lastMessage ||
      subscription.lastMessage < Date.now() - this.reconnectIntervalMs
    ) {
      this._reconnect(subscription);
    }
  }

  ////////////////////////////////////////////
  // ABSTRACT

  _onMessage(remote_id, raw) {
    let msg = JSON.parse(raw);
    let subscription = this._subscriptions.get(remote_id);
    if (!subscription) {
      // if regular subscription isn't available, try the top_of_book special subscription
      // which is used for ticker support
      const subscriptionId = remote_id + this.topOfBookIndicator;
      subscription = this._subscriptions.get(subscriptionId);
    }
    let market = subscription.market;
    subscription.lastMessage = Date.now();

    if (!market) return;

    if (msg.type === "update") {
      let { timestampms, eventId, socket_sequence } = msg;

      // process trades
      if (subscription.trades) {
        let events = msg.events.filter(p => p.type === "trade" && /ask|bid/.test(p.makerSide));
        for (let event of events) {
          let trade = this._constructTrade(event, market, timestampms);
          this.emit("trade", trade, market);
        }
        return;
      }

      // process l2 updates
      if (subscription.level2updates) {
        let updates = msg.events.filter(p => p.type === "change");
        if (socket_sequence === 0) {
          let snapshot = this._constructL2Snapshot(updates, market, eventId);
          this.emit("l2snapshot", snapshot, market);
        } else {
          let update = this._constructL2Update(updates, market, eventId, timestampms);
          this.emit("l2update", update, market);
        }
        return;
      }
      if (subscription.tickers) {
        const marketId = subscription.market.id;
        this.tickersCache[marketId] = this.tickersCache[marketId] || new TickerCache({ market: subscription.market });
        const newAsk = msg.events.find(thisEvt => thisEvt.type === 'change' && thisEvt.side === 'ask');
        const newBid = msg.events.find(thisEvt => thisEvt.type === 'change' && thisEvt.side === 'bid');
        const newTrade = msg.events.find(thisEvt => thisEvt.type === 'trade');
        if (newAsk) {
          this.tickersCache[marketId].setAsk(newAsk.price);
        }
        if (newBid) {
          this.tickersCache[marketId].setBid(newBid.price);
        }
        if (newTrade) {
          this.tickersCache[marketId].setLast(newTrade.price);
        }
        this.tickersCache[marketId].setTimestamp(msg.timestamp)
        this.emit("ticker", this.tickersCache[marketId].getTicker(), market);
      } 
    }
  }

  _constructTrade(event, market, timestamp) {
    let side = event.makerSide === "ask" ? "sell" : "buy";
    let price = event.price;
    let amount = event.amount;

    return new Trade({
      exchange: "Gemini",
      base: market.base,
      quote: market.quote,
      tradeId: event.tid.toFixed(),
      side,
      unix: timestamp,
      price,
      amount,
    });
  }

  _constructL2Snapshot(events, market, sequenceId) {
    let asks = [];
    let bids = [];

    for (let { side, price, remaining, reason, delta } of events) {
      let update = new Level2Point(price, remaining, undefined, { reason, delta });
      if (side === "ask") asks.push(update);
      else bids.push(update);
    }

    return new Level2Snapshot({
      exchange: "Gemini",
      base: market.base,
      quote: market.quote,
      sequenceId,
      asks,
      bids,
    });
  }

  _constructL2Update(events, market, sequenceId, timestampMs) {
    let asks = [];
    let bids = [];

    for (let { side, price, remaining, reason, delta } of events) {
      let update = new Level2Point(price, remaining, undefined, { reason, delta });
      if (side === "ask") asks.push(update);
      else bids.push(update);
    }

    return new Level2Update({
      exchange: "Gemini",
      base: market.base,
      quote: market.quote,
      sequenceId,
      timestampMs,
      asks,
      bids,
    });
  }
}

module.exports = GeminiClient;
