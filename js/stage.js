/*
 * パネル表示（ステージ）の描画。ホスト画面（index.html）と表示用ページ（board.html）で共通
 *
 * ホスト画面が作った「表示用データ（view）」を受け取って、問題文・パネル・順位を描く。
 * view の形:
 *  {
 *    code, busy, joinUrl,                 参加コード（busy のときは準備中）
 *    survey,                              アンケートモード（得点・○×・正解を出さない）
 *    lobby,                               まだ一度も出題していない（参加コードと QR コードを出し続ける）
 *    phase: waiting|open|closed|judged|final, view: board|rank, final,
 *    q: null | {id, no, type, text, choices, correct},
 *    dl, correctText, counts,             制限時間の締め切り・正解・選択肢ごとの人数
 *    stampWave, rankWave,                 ○× と順位の演出を始めた時刻
 *    players: [{pid, name, score, online, answered, opened, click, ans: null | {k, v}, j}]
 *  }
 * 回答の中身（ans）は、パネルを開いたものだけが入っている。
 */
(function (global) {
  'use strict';

  var QP = global.QP;
  var esc = QP.esc;
  var now = QP.now;

  function $(sel, root) { return root.querySelector(sel); }

  // ---- QR コード ----
  var qrLoading = null;
  QP.loadQr = function () {
    if (typeof global.qrcode === 'function') return Promise.resolve();
    if (!qrLoading) {
      qrLoading = QP.loadFirst([
        'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js',
        'vendor/qrcode.js'
      ], function () { return typeof global.qrcode === 'function'; });
    }
    return qrLoading;
  };
  QP.renderQr = function (el, text, cell) {
    if (!el || !text) return;
    QP.loadQr().then(function () {
      var qr = global.qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      el.innerHTML = qr.createSvgTag({ cellSize: cell || 6, margin: 2, scalable: true });
    }).catch(function () {
      el.innerHTML = '<div class="muted small">QRコードを表示できませんでした</div>';
    });
  };

  QP.joinCardHtml = function (code, url, busy, big) {
    if (!code || busy) return '<div class="join-card"><div class="jc-title">参加コードを準備しています…</div></div>';
    return '<div class="join-card' + (big ? ' big' : '') + '">' +
      '<div class="jc-left"><div class="jc-title">スマホで参加してください</div>' +
      '<div class="jc-code-label">参加コード</div><div class="jc-code">' + QP.formatCode(code) + '</div>' +
      '<div class="jc-url">' + esc(url) + '</div></div>' +
      '<div class="join-qr"></div></div>';
  };

  /**
   * @param {Element} root .stage 要素（中に .stage-head / .board-wrap > .board-grid, .board-empty / .ranking）
   * @param {object} opts { onPanelClick(pid) }
   */
  function Stage(root, opts) {
    this.root = root;
    this.opts = opts || {};
    this.head = $('.stage-head', root);
    this.wrap = $('.board-wrap', root);
    this.grid = $('.board-grid', root);
    this.empty = $('.board-empty', root);
    this.rankEl = $('.ranking', root);
    this.panels = new Map();
    this.layoutSig = '';
    this.view = null;
    var self = this;
    if (this.opts.onPanelClick) {
      this.grid.addEventListener('click', function (e) {
        var p = e.target.closest('.panel');
        if (p) self.opts.onPanelClick(p.dataset.pid);
      });
    }
  }

  Stage.prototype.render = function (view) {
    this.view = view;
    this.root.dataset.phase = view.phase;
    this.root.dataset.view = view.view;
    this.root.dataset.mode = view.survey ? 'survey' : 'quiz';
    var rank = view.view === 'rank';
    this.rankEl.hidden = !rank;
    this.wrap.hidden = rank;
    this.renderHead();
    this.renderBoard();
    if (rank) this.renderRanking();
    this.tick();
  };

  /** 画面の大きさが変わったときなど、パネルの並びと文字の大きさを合わせ直す */
  Stage.prototype.relayout = function () {
    this.layoutSig = '';
    if (this.view) this.layout([]);
  };

  // 制限時間の表示（毎秒呼ぶ）
  Stage.prototype.tick = function () {
    var el = $('.sh-timer', this.head);
    if (!el || !this.view) return;
    var v = this.view;
    var remain = v.phase === 'open' && v.dl ? Math.max(0, Math.ceil((v.dl - now()) / 1000)) : null;
    var text = remain == null ? '' : String(remain);
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle('hurry', remain != null && remain <= 5);
  };

  Stage.prototype.renderHead = function () {
    var v = this.view;
    var q = v.q;
    var html;
    if (v.view === 'rank') {
      html = '';
    } else if (!q) {
      html = '<div class="sh-main"><div class="sh-text">問題を登録してください</div></div>';
    } else {
      html = '<div class="sh-main"><div class="sh-no">' + (v.survey ? '質問' + q.no : '第' + q.no + '問') + '</div>';
      if (v.phase === 'waiting') {
        html += '<div class="sh-text sh-wait">まもなく出題します</div>';
      } else {
        html += '<div class="sh-text">' + esc(q.text) + '</div>';
        if (q.type === 'choice') {
          html += '<div class="sh-choices">' + q.choices.map(function (c, k) {
            var cls = 'ch c' + k + (v.phase === 'judged' && q.correct.indexOf(k) >= 0 ? ' right' : '');
            return '<span class="' + cls + '"><b>' + QP.choiceLabel(k) + '</b>' + esc(c) +
              (v.counts ? '<i>' + v.counts[k] + '人</i>' : '') + '</span>';
          }).join('') + '</div>';
        }
      }
      html += '</div><div class="sh-side">';
      if (v.phase === 'open') {
        html += v.dl ? '<div class="sh-timer"></div>' : '<div class="sh-badge">回答受付中</div>';
      } else if (v.phase === 'closed') {
        html += '<div class="sh-badge closed">締め切り</div>';
      }
      if (v.code && !v.busy) {
        html += '<div class="sh-code"><small>参加コード</small>' + QP.formatCode(v.code) + '</div>';
      }
      html += '</div>';
      if (v.phase === 'judged' && v.correctText) {
        html += '<div class="sh-correct"><span>正解</span>' + esc(v.correctText) + '</div>';
      }
    }
    // 同じ内容なら書き換えない（演出がやり直しにならないように）
    if (this._headHtml !== html) {
      this._headHtml = html;
      this.head.innerHTML = html;
    }
  };

  function createPanel(pid) {
    var el = document.createElement('div');
    el.className = 'panel';
    el.dataset.pid = pid;
    el.innerHTML =
      '<div class="flip">' +
        '<div class="face back"><div class="back-inner"><div class="lamp"></div><div class="pnum"></div><div class="back-label"></div></div></div>' +
        '<div class="face front"><div class="board-inner"></div></div>' +
      '</div>' +
      '<div class="stamp"></div>' +
      '<div class="plate"><span class="pname"></span><span class="pscore"></span><span class="poff" title="通信が切れています">●</span></div>';
    return el;
  }

  Stage.prototype.renderBoard = function () {
    var self = this;
    var v = this.view;
    var ids = {};
    v.players.forEach(function (p) { ids[p.pid] = true; });
    this.panels.forEach(function (el, pid) {
      if (!ids[pid]) { el.remove(); self.panels.delete(pid); }
    });

    var needFit = [];
    v.players.forEach(function (p, i) {
      var el = self.panels.get(p.pid);
      if (!el) { el = createPanel(p.pid); self.panels.set(p.pid, el); }
      if (self.grid.children[i] !== el) self.grid.insertBefore(el, self.grid.children[i] || null);
      if (self.updatePanel(el, p, i)) needFit.push(el);
    });

    // 最初の出題までは（参加者がいても）参加コードと QR コードを出し続け、参加した人の名前を並べる
    var lobby = !!v.lobby || !v.players.length;
    if (lobby) {
      this.empty.hidden = false;
      var key = v.busy ? 'busy' : v.code + '|' + v.joinUrl;
      if (this._emptyKey !== key) {
        this._emptyKey = key;
        this.empty.innerHTML = '<div class="lobby">' + QP.joinCardHtml(v.code, v.joinUrl, v.busy, true) +
          '<div class="lobby-people"><div class="lp-title"></div><div class="lp-names"></div></div></div>';
        this.chips = new Map();
        if (!v.busy) QP.renderQr($('.join-qr', this.empty), v.joinUrl, 6);
      }
      this.renderLobbyPeople();
    } else {
      this.empty.hidden = true;
    }
    this.wrap.classList.toggle('is-empty', lobby);
    this.layout(needFit);
  };

  // 参加した人の名前（新しく参加した人だけ、ぽんと出す）
  Stage.prototype.renderLobbyPeople = function () {
    var self = this;
    var people = $('.lobby-people', this.empty);
    if (!people) return;
    var players = this.view.players;
    var title = players.length ? '参加者 <b>' + players.length + '</b> 人' : '参加を待っています…';
    var t = $('.lp-title', people);
    if (t.innerHTML !== title) t.innerHTML = title;
    people.classList.toggle('many', players.length > 24);
    var box = $('.lp-names', people);
    var ids = {};
    players.forEach(function (p) { ids[p.pid] = true; });
    this.chips.forEach(function (el, pid) {
      if (!ids[pid]) { el.remove(); self.chips.delete(pid); }
    });
    players.forEach(function (p, i) {
      var el = self.chips.get(p.pid);
      if (!el) {
        el = document.createElement('span');
        el.className = 'lp-chip new';
        el.addEventListener('animationend', function () { el.classList.remove('new'); });
        self.chips.set(p.pid, el);
      }
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
      if (el.textContent !== p.name) el.textContent = p.name;
      el.classList.toggle('off', !p.online);
    });
  };

  Stage.prototype.updatePanel = function (el, p, i) {
    var v = this.view;
    var q = v.q;
    var phase = v.phase;

    el.classList.toggle('answered', !!p.answered);
    el.classList.toggle('opened', !!p.opened);
    el.classList.toggle('offline', !p.online);
    el.classList.toggle('clickable', !!p.click);
    el.dataset.phase = phase;

    $('.pnum', el).textContent = i + 1;
    var bl = '';
    if (phase === 'open') bl = p.answered ? '回答済み' : '考え中…';
    else if (phase === 'closed' || phase === 'judged') bl = p.answered ? '' : '無回答';
    $('.back-label', el).textContent = bl;
    $('.pname', el).textContent = p.name;
    $('.pscore', el).textContent = (p.score || 0) + '点';

    // 回答の中身（変わったときだけ書き換える）
    var key = q && p.ans ? p.ans.k : (q && p.opened ? q.id + ':none' : '');
    var fit = false;
    if (el._key !== key) {
      el._key = key;
      var bi = $('.board-inner', el);
      if (!key) {
        bi.innerHTML = '';
      } else if (!p.ans) {
        bi.innerHTML = '<div class="ans-none">無回答</div>';
      } else if (q.type === 'choice') {
        var c = p.ans.v;
        bi.innerHTML = '<div class="ans-choice"><span class="cl c' + c + '">' + QP.choiceLabel(c) + '</span><span class="ct">' + esc(q.choices[c] || '') + '</span></div>';
        fit = true;
      } else if (q.type === 'draw') {
        bi.innerHTML = QP.drawSvg(p.ans.v, { width: 9 });
      } else {
        bi.innerHTML = '<div class="ans-text">' + esc(p.ans.v) + '</div>';
        fit = true;
      }
    }

    // ○×
    var stamp = $('.stamp', el);
    var sk = p.j === 1 ? 'ok' : (p.j === 0 ? 'ng' : '');
    if (stamp._k !== sk) {
      stamp._k = sk;
      stamp.className = 'stamp' + (sk ? ' show ' + sk : '');
      stamp.innerHTML = sk === 'ok'
        ? '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="36" /></svg>'
        : sk === 'ng' ? '<svg viewBox="0 0 100 100"><path d="M20 20 L80 80 M80 20 L20 80" /></svg>' : '';
      // 正解発表の直後は、左上から順番に押していく
      stamp.style.animationDelay = sk && v.stampWave && now() - v.stampWave < 1500 ? (Math.min(i, 30) * 0.07) + 's' : '0s';
    }
    return fit;
  };

  Stage.prototype.layout = function (needFit) {
    var n = this.view.players.length;
    if (!n || this.wrap.hidden) { this.layoutSig = ''; return; }
    var W = this.wrap.clientWidth;
    var H = this.wrap.clientHeight;
    if (!W || !H) {
      // 見えていないときは測れないので、次に見えたときに全部合わせ直す
      this.layoutSig = '';
      return;
    }
    var gap = Math.round(Math.max(8, Math.min(W, H) * 0.018));
    var pr = (5 / 3) / 1.24; // パネル全体の 横/縦（ボード 5:3 + 名札）
    var best = { pw: 0, cols: 1 };
    for (var c = 1; c <= n; c++) {
      var rows = Math.ceil(n / c);
      var pw = Math.min((W - gap * (c - 1)) / c, ((H - gap * (rows - 1)) / rows) * pr);
      if (pw > best.pw) best = { pw: pw, cols: c };
    }
    var pwi = Math.max(60, Math.floor(best.pw));
    var sig = pwi + 'x' + best.cols;
    if (sig !== this.layoutSig) {
      this.layoutSig = sig;
      this.grid.style.setProperty('--pw', pwi + 'px');
      this.grid.style.gridTemplateColumns = 'repeat(' + best.cols + ', ' + pwi + 'px)';
      this.grid.style.gap = gap + 'px';
      needFit = Array.from(this.panels.values());
    }
    (needFit || []).forEach(fitPanel);
  };

  function fitPanel(el) {
    var bi = $('.board-inner', el);
    var t = $('.ans-text', el);
    if (t) QP.fitTextPreferOneLine(t, bi, 10, bi.clientHeight * 0.62);
    var ct = $('.ans-choice .ct', el);
    if (ct) {
      // 選択肢の文字は下のほうに収める
      var box = { clientWidth: bi.clientWidth * 0.92, clientHeight: bi.clientHeight * 0.3 };
      QP.fitText(ct, box, 8, bi.clientHeight * 0.2);
    }
  }

  Stage.prototype.renderRanking = function () {
    var v = this.view;
    var score = {};
    var name = {};
    v.players.forEach(function (p) { score[p.pid] = p.score || 0; name[p.pid] = p.name; });
    var rk = QP.ranks(v.players.map(function (p) { return p.pid; }), function (pid) { return score[pid]; });
    var n = rk.order.length;
    var title = v.final ? '最終結果' : '現在の順位';
    var rows = rk.order.map(function (pid) {
      var r = rk.rank[pid];
      return { cls: 'rk' + (r <= 3 ? ' top' + r : ''), inner: '<span class="rk-no">' + r + '<small>位</small></span><span class="rk-name">' + esc(name[pid]) + '</span>' +
        '<span class="rk-pt">' + score[pid] + '<small>点</small></span>' };
    });
    var core = title + '|' + rows.map(function (x) { return x.cls + x.inner; }).join('');
    if (this._rankCore === core) return;
    this._rankCore = core;
    // 発表の直後だけ、下の順位から順番に出す
    var anim = v.rankWave && now() - v.rankWave < 1500;
    var html = '<div class="rank-title">' + title + '</div>';
    if (!n) {
      html += '<div class="rank-empty">参加者がいません</div>';
    } else {
      html += '<ol class="rank-list' + (n > 10 ? ' dense' : '') + '">' + rows.map(function (x, k) {
        var delay = anim ? Math.min(6, (n - 1 - k) * Math.min(0.35, 4 / n)) : 0;
        return '<li class="' + x.cls + '" style="animation-delay:' + delay.toFixed(2) + 's">' + x.inner + '</li>';
      }).join('') + '</ol>';
    }
    this.rankEl.innerHTML = html;
  };

  QP.Stage = Stage;
})(window);
