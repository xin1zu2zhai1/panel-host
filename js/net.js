/*
 * 複数の MQTT サーバーへ同時に接続するための小さなラッパー（ホスト側・回答者側で共通）
 *
 *  - 設定されたサーバーすべてに同時接続する（切り替え方式ではない）
 *  - publish はつながっている全サーバーへ送る
 *  - 受信はどのサーバーから届いても onMessage に渡す（どのサーバー経由かは idx で分かる）
 *  - clientId は接続・再接続のたびにランダムに作り直す
 *    （遺言メッセージ(Will)にも同じ cid を入れるので、古い接続の遺言を見分けられる）
 */
(function (global) {
  'use strict';

  var CFG = global.QP_CONFIG;

  function randomId(len) {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    var buf = new Uint8Array(len);
    (global.crypto || global.msCrypto).getRandomValues(buf);
    for (var i = 0; i < len; i++) out += chars[buf[i] % chars.length];
    return out;
  }

  function decode(payload) {
    if (payload == null) return '';
    if (typeof payload === 'string') return payload;
    try {
      return new TextDecoder('utf-8').decode(payload);
    } catch (e) {
      return String(payload);
    }
  }

  /**
   * @param {object} opts
   *  - brokers: [{name, url, username?, password?}]
   *  - subscriptions: [{topic, qos}]
   *  - will(cid): {topic, payload, qos, retain} | null
   *  - onMessage(topic, text, idx, packet)
   *  - onConnect(idx, cid)   … 接続・再接続のたび
   *  - onDown(idx)           … つながっていた接続が切れたとき
   *  - onStatus(list)        … 接続状態が変わったとき
   */
  function MultiBroker(opts) {
    this.opts = opts;
    this.subs = (opts.subscriptions || []).slice();
    this.links = [];
    this.stopped = false;
    this._onVisible = this._onVisible.bind(this);
  }

  MultiBroker.prototype.start = function () {
    var self = this;
    if (typeof global.mqtt === 'undefined') {
      throw new Error('mqtt.js が読み込まれていません');
    }
    this.stopped = false;
    this.opts.brokers.forEach(function (cfg, idx) {
      self._open(idx, cfg);
    });
    document.addEventListener('visibilitychange', this._onVisible);
    global.addEventListener('online', this._onVisible);
    global.addEventListener('pageshow', this._onVisible);
  };

  MultiBroker.prototype._willFor = function (cid) {
    return this.opts.will ? this.opts.will(cid) : null;
  };

  MultiBroker.prototype._open = function (idx, cfg) {
    var self = this;
    var link = {
      idx: idx,
      name: cfg.name,
      url: cfg.url,
      cid: 'qp_' + randomId(12),
      state: 'connecting',
      up: false,
      error: '',
      client: null,
      since: Date.now()
    };
    this.links[idx] = link;

    var options = {
      clientId: link.cid,
      keepalive: CFG.KEEPALIVE_SEC,
      reconnectPeriod: CFG.RECONNECT_MS,
      connectTimeout: CFG.CONNECT_TIMEOUT_MS,
      clean: true,
      protocolVersion: 4,
      resubscribe: false
    };
    if (cfg.username) options.username = cfg.username;
    if (cfg.password) options.password = cfg.password;
    var will = this._willFor(link.cid);
    if (will) options.will = will;

    var client;
    try {
      client = global.mqtt.connect(cfg.url, options);
    } catch (e) {
      link.state = 'error';
      link.error = String(e && e.message || e);
      this._status();
      return;
    }
    link.client = client;

    client.on('connect', function () {
      link.up = true;
      link.state = 'connected';
      link.error = '';
      link.since = Date.now();
      self.subs.forEach(function (s) {
        client.subscribe(s.topic, { qos: s.qos == null ? 1 : s.qos });
      });
      self._status();
      if (self.opts.onConnect) self.opts.onConnect(idx, link.cid);
    });

    client.on('reconnect', function () {
      // 再接続のたびに clientId と遺言メッセージを作り直す
      link.cid = 'qp_' + randomId(12);
      client.options.clientId = link.cid;
      var w = self._willFor(link.cid);
      if (w) client.options.will = w;
      link.state = 'connecting';
      self._status();
    });

    client.on('close', function () {
      var wasUp = link.up;
      link.up = false;
      if (!self.stopped) link.state = 'offline';
      self._status();
      if (wasUp && self.opts.onDown) self.opts.onDown(idx);
    });

    client.on('error', function (err) {
      link.error = String(err && err.message || err);
      self._status();
    });

    client.on('message', function (topic, payload, packet) {
      if (self.stopped) return;
      if (self.opts.onMessage) self.opts.onMessage(topic, decode(payload), idx, packet);
    });
  };

  MultiBroker.prototype._status = function () {
    if (this.opts.onStatus) this.opts.onStatus(this.status());
  };

  MultiBroker.prototype.status = function () {
    return this.links.map(function (l) {
      return { idx: l.idx, name: l.name, state: l.state, error: l.error, cid: l.cid };
    });
  };

  MultiBroker.prototype.connectedCount = function () {
    return this.links.filter(function (l) { return l.up; }).length;
  };

  MultiBroker.prototype.isUp = function (idx) {
    var l = this.links[idx];
    return !!(l && l.up);
  };

  MultiBroker.prototype.cidOf = function (idx) {
    var l = this.links[idx];
    return l ? l.cid : '';
  };

  /**
   * つながっている全サーバーへ送る。
   * payload に関数を渡すと、サーバーごとに payload(link) の戻り値を送る（cid を入れたいとき用）
   */
  MultiBroker.prototype.publish = function (topic, payload, opts) {
    var self = this;
    var sent = 0;
    this.links.forEach(function (l) {
      if (self.publishTo(l.idx, topic, payload, opts)) sent++;
    });
    return sent;
  };

  MultiBroker.prototype.publishTo = function (idx, topic, payload, opts) {
    var l = this.links[idx];
    if (!l || !l.up || !l.client) return false;
    var body = typeof payload === 'function' ? payload(l) : payload;
    try {
      l.client.publish(topic, body, {
        qos: opts && opts.qos != null ? opts.qos : 1,
        retain: !!(opts && opts.retain)
      });
      return true;
    } catch (e) {
      return false;
    }
  };

  /** 購読するトピックを入れ替える（参加コードを変えたときなど） */
  MultiBroker.prototype.setSubscriptions = function (subs) {
    var oldTopics = this.subs.map(function (s) { return s.topic; });
    var newTopics = subs.map(function (s) { return s.topic; });
    this.subs = subs.slice();
    this.links.forEach(function (l) {
      if (!l.up) return;
      oldTopics.forEach(function (t) {
        if (newTopics.indexOf(t) < 0) l.client.unsubscribe(t);
      });
      subs.forEach(function (s) {
        if (oldTopics.indexOf(s.topic) < 0) l.client.subscribe(s.topic, { qos: s.qos == null ? 1 : s.qos });
      });
    });
  };

  /** 同じ購読をし直す。サーバーが保持している最新の retain メッセージがもう一度届く */
  MultiBroker.prototype.resubscribe = function (topic, qos) {
    this.links.forEach(function (l) {
      if (l.up) l.client.subscribe(topic, { qos: qos == null ? 1 : qos });
    });
  };

  /** 一時的に購読して、waitMs の間に届いたメッセージを集める（参加コードの使用中チェック用） */
  MultiBroker.prototype.peek = function (topic, waitMs) {
    var self = this;
    return new Promise(function (resolve) {
      var got = [];
      var handlers = [];
      self.links.forEach(function (l) {
        if (!l.up) return;
        var h = function (t, payload) {
          if (t === topic) got.push(decode(payload));
        };
        l.client.on('message', h);
        handlers.push({ l: l, h: h });
        l.client.subscribe(topic, { qos: 0 });
      });
      setTimeout(function () {
        handlers.forEach(function (x) {
          x.l.client.removeListener('message', x.h);
          var keep = self.subs.some(function (s) { return s.topic === topic; });
          if (!keep && x.l.up) x.l.client.unsubscribe(topic);
        });
        resolve(got);
      }, waitMs);
    });
  };

  /** 少なくとも1つのサーバーにつながるまで待つ（timeoutMs で諦める） */
  MultiBroker.prototype.waitAny = function (timeoutMs) {
    var self = this;
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function check() {
        if (self.connectedCount() > 0) return resolve(true);
        if (Date.now() - t0 > timeoutMs) return resolve(false);
        setTimeout(check, 200);
      })();
    });
  };

  MultiBroker.prototype._onVisible = function () {
    if (this.stopped) return;
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    // 再接続待ちのものはすぐ再接続する
    this.links.forEach(function (l) {
      var c = l.client;
      if (!c || l.up) return;
      if (c.reconnectTimer) {
        try { c.reconnect(); } catch (e) { /* ignore */ }
      }
    });
    if (this.opts.onVisible) this.opts.onVisible();
  };

  /** すべての接続を閉じる。beforeEnd(link) で最後のメッセージを送れる */
  MultiBroker.prototype.stop = function (beforeEnd) {
    var self = this;
    this.stopped = true;
    document.removeEventListener('visibilitychange', this._onVisible);
    global.removeEventListener('online', this._onVisible);
    global.removeEventListener('pageshow', this._onVisible);
    return Promise.all(this.links.map(function (l) {
      return new Promise(function (resolve) {
        if (!l.client) return resolve();
        if (l.up && beforeEnd) {
          try { beforeEnd(l); } catch (e) { /* ignore */ }
        }
        var done = false;
        var finish = function () { if (!done) { done = true; resolve(); } };
        try { l.client.end(false, {}, finish); } catch (e) { finish(); }
        setTimeout(finish, 1500);
        l.state = 'offline';
        l.up = false;
      });
    })).then(function () { self._status(); });
  };

  global.QP_NET = {
    MultiBroker: MultiBroker,
    randomId: randomId
  };
})(window);
