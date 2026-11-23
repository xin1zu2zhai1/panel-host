/*
 * ホスト側・回答者側で共通の小さな道具
 */
(function (global) {
  'use strict';

  var CFG = global.QP_CONFIG;
  var QP = {};

  QP.TTL_MS = CFG.SESSION_TTL_HOURS * 60 * 60 * 1000;

  QP.topic = function (code, kind) {
    return CFG.APP_NS + '/' + code + '/' + kind;
  };

  QP.now = function () { return Date.now(); };

  QP.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  QP.parse = function (text) {
    try {
      var v = JSON.parse(text);
      return v && typeof v === 'object' ? v : null;
    } catch (e) {
      return null;
    }
  };

  QP.formatCode = function (code) {
    code = String(code || '');
    return code.length === 6 ? code.slice(0, 3) + ' ' + code.slice(3) : code;
  };

  QP.isCode = function (code) { return /^\d{6}$/.test(String(code || '')); };

  QP.choiceLabel = function (i) { return 'ABCDEFGH'.charAt(i) || String(i + 1); };

  // ---- 端末への保存（使えない環境でも止まらないように try/catch で囲む） ----
  var memStore = {};
  QP.storageOk = (function () {
    try {
      var k = '__qp_test__';
      global.localStorage.setItem(k, '1');
      global.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  })();

  QP.store = {
    get: function (key, def) {
      try {
        var raw = global.localStorage.getItem('qp:' + key);
        if (raw == null) return key in memStore ? memStore[key] : def;
        return JSON.parse(raw);
      } catch (e) {
        return key in memStore ? memStore[key] : def;
      }
    },
    set: function (key, val) {
      memStore[key] = val;
      try {
        global.localStorage.setItem('qp:' + key, JSON.stringify(val));
        return true;
      } catch (e) {
        return false;
      }
    },
    del: function (key) {
      delete memStore[key];
      try { global.localStorage.removeItem('qp:' + key); } catch (e) { /* ignore */ }
    }
  };

  // ---- ライブラリの読み込み（CDN → 自前のファイル の順に試す） ----
  QP.loadScript = function (src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(src); };
      s.onerror = function () { s.remove(); reject(new Error('load failed: ' + src)); };
      document.head.appendChild(s);
    });
  };

  QP.loadFirst = function (srcs, check) {
    var i = 0;
    return new Promise(function (resolve, reject) {
      (function next() {
        if (check && check()) return resolve();
        if (i >= srcs.length) return reject(new Error('all sources failed'));
        QP.loadScript(srcs[i++]).then(function () {
          if (!check || check()) resolve(); else next();
        }, next);
      })();
    });
  };

  QP.loadMqtt = function () {
    return QP.loadFirst([
      'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js',
      'vendor/mqtt.min.js'
    ], function () { return typeof global.mqtt !== 'undefined'; });
  };

  // ---- 回答の判定 ----
  // 全角半角・大文字小文字・ひらがなカタカナ・空白や記号の違いは同じとみなす
  QP.normalize = function (s) {
    s = String(s == null ? '' : s);
    try { s = s.normalize('NFKC'); } catch (e) { /* ignore */ }
    s = s.toLowerCase();
    s = s.replace(/[ァ-ヶ]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0x60);
    });
    s = s.replace(/[\s　・･、。!！?？「」『』（）()［］\[\]【】"'“”‘’〜~]/g, '');
    return s;
  };

  QP.splitAnswers = function (text) {
    return String(text || '').split(/[\n\r]+|／/).map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length > 0; });
  };

  QP.textMatches = function (answer, correctList) {
    var a = QP.normalize(answer);
    if (!a) return false;
    for (var i = 0; i < correctList.length; i++) {
      if (QP.normalize(correctList[i]) === a) return true;
    }
    return false;
  };

  // ---- 手書き回答 ----
  // 値の形: { s: [[x0,y0,x1,y1,...], ...] } 座標は 0..DRAW_W, 0..DRAW_H の整数
  QP.validDraw = function (v) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.s)) return false;
    if (v.s.length > 400) return false;
    var total = 0;
    for (var i = 0; i < v.s.length; i++) {
      var st = v.s[i];
      if (!Array.isArray(st) || st.length < 2 || st.length % 2) return false;
      total += st.length / 2;
      if (total > CFG.MAX_DRAW_POINTS) return false;
      for (var j = 0; j < st.length; j++) {
        var n = st[j];
        if (typeof n !== 'number' || !isFinite(n)) return false;
        var max = j % 2 ? CFG.DRAW_H : CFG.DRAW_W;
        if (n < 0 || n > max) return false;
      }
    }
    return true;
  };

  QP.drawIsEmpty = function (v) {
    return !v || !v.s || v.s.length === 0;
  };

  QP.drawSvg = function (v, opts) {
    opts = opts || {};
    var W = CFG.DRAW_W, H = CFG.DRAW_H;
    var color = opts.color || '#111';
    var width = opts.width || 9;
    var parts = [];
    (v && v.s || []).forEach(function (st) {
      if (st.length === 2) {
        parts.push('<circle cx="' + st[0] + '" cy="' + st[1] + '" r="' + (width / 2) + '" fill="' + color + '"/>');
        return;
      }
      var d = 'M' + st[0] + ' ' + st[1];
      for (var i = 2; i < st.length; i += 2) d += 'L' + st[i] + ' ' + st[i + 1];
      parts.push('<path d="' + d + '"/>');
    });
    return '<svg class="draw-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
      '<g fill="none" stroke="' + color + '" stroke-width="' + width + '" stroke-linecap="round" stroke-linejoin="round">' +
      parts.join('') + '</g></svg>';
  };

  // ---- 文字を枠いっぱいの大きさにする ----
  QP.fitText = function (el, box, minPx, maxPx) {
    if (!el || !box) return;
    var bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    var lo = minPx || 8, hi = maxPx || 200, best = lo;
    for (var i = 0; i < 9; i++) {
      var mid = (lo + hi) / 2;
      el.style.fontSize = mid + 'px';
      if (el.scrollWidth <= bw + 1 && el.scrollHeight <= bh + 1) {
        best = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    el.style.fontSize = Math.floor(best) + 'px';
  };

  // 1行に収めたときの大きさが、折り返したときの6割以上なら1行にする
  QP.fitTextPreferOneLine = function (el, box, minPx, maxPx) {
    el.style.whiteSpace = 'normal';
    QP.fitText(el, box, minPx, maxPx);
    var wrapped = parseFloat(el.style.fontSize) || 0;
    el.style.whiteSpace = 'nowrap';
    QP.fitText(el, box, minPx, maxPx);
    var single = parseFloat(el.style.fontSize) || 0;
    if (single < wrapped * 0.6) {
      el.style.whiteSpace = 'normal';
      el.style.fontSize = wrapped + 'px';
    }
  };

  // 同点は同じ順位（1,1,3…）
  QP.ranks = function (list, scoreOf) {
    var sorted = list.slice().sort(function (a, b) { return scoreOf(b) - scoreOf(a); });
    var out = {};
    var prev = null, rank = 0;
    sorted.forEach(function (id, i) {
      var s = scoreOf(id);
      if (s !== prev) { rank = i + 1; prev = s; }
      out[id] = rank;
    });
    return { order: sorted, rank: out };
  };

  QP.toast = function (msg, ms) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(QP._toastTimer);
    QP._toastTimer = setTimeout(function () { el.classList.remove('show'); }, ms || 2600);
  };

  QP.copyText = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return QP._copyFallback(text); });
    }
    return Promise.resolve(QP._copyFallback(text));
  };
  QP._copyFallback = function (text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  };

  global.QP = QP;
})(window);
