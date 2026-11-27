/*
 * 表示用ページ（画面共有・プロジェクター用）
 *
 * 同じブラウザで開いているホスト画面から BroadcastChannel で表示用データを受け取り、
 * パネルの一覧だけを描く。MQTT には接続しない。
 * ここで押したキーやパネルのクリックは、ホスト画面へ送って操作として扱う。
 */
(function () {
  'use strict';

  var QP = window.QP;
  var $ = function (sel) { return document.querySelector(sel); };
  var now = QP.now;
  var id = 'b' + Math.random().toString(36).slice(2, 10);
  var ch = null;
  var lastViewAt = 0;
  var gotView = false;

  var stage = new QP.Stage($('#stage'), {
    onPanelClick: function (pid) { send({ t: 'click', pid: pid }); }
  });

  function send(m) {
    if (!ch) return;
    m.id = id;
    try { ch.postMessage(m); } catch (e) { /* ignore */ }
  }

  function toggleFullscreen() {
    var de = document.documentElement;
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(function () { /* ignore */ });
    } else if (de.requestFullscreen) {
      de.requestFullscreen().catch(function () { /* ignore */ });
    }
  }

  // ---- ホスト画面とのやりとり ----
  if (!('BroadcastChannel' in window)) {
    $('#waiting .bp-title').textContent = 'このブラウザでは表示用ページを使えません';
    $('#waiting p').textContent = '新しいバージョンの Chrome・Edge・Safari・Firefox でお試しください。';
  } else {
    ch = new BroadcastChannel('quizpanel-board');
    ch.onmessage = function (e) {
      var m = e.data || {};
      if (m.t !== 'view' || !m.view) return;
      lastViewAt = now();
      if (!gotView) {
        gotView = true;
        $('#waiting').hidden = true;
      }
      $('#lost').hidden = true;
      stage.render(m.view);
    };
    send({ t: 'hello' });
    setInterval(function () { send({ t: 'ping' }); }, 2000);
    window.addEventListener('pagehide', function () { send({ t: 'bye' }); });
  }

  setInterval(function () {
    stage.tick();
    // ホスト画面は2秒ごとに送ってくるので、しばらく届かなければ知らせる
    if (gotView) $('#lost').hidden = now() - lastViewAt < 7000;
  }, 250);

  // ---- 操作 ----
  var KEYS = { ' ': 1, Enter: 1, a: 1, A: 1, n: 1, N: 1, j: 1, J: 1, ArrowLeft: 1, ArrowRight: 1, r: 1, R: 1 };
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); return; }
    if (e.key === 'Escape') { $('#help').hidden = true; return; }
    if (KEYS[e.key]) {
      e.preventDefault();
      send({ t: 'key', key: e.key });
    }
  });
  document.addEventListener('dblclick', function (e) {
    if (e.target.closest('.panel, .bp-tools, .bp-help')) return;
    toggleFullscreen();
  });
  $('#fsBtn').addEventListener('click', toggleFullscreen);
  $('#helpBtn').addEventListener('click', function () { $('#help').hidden = !$('#help').hidden; });
  $('#help').addEventListener('click', function () { $('#help').hidden = true; });

  // しばらくマウスを動かさなければ、ボタンとカーソルを隠す
  var idleTimer = null;
  function poke() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { document.body.classList.add('idle'); }, 2500);
  }
  document.addEventListener('mousemove', poke);
  poke();

  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () { stage.relayout(); }, 120);
  });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { stage.relayout(); });
  }
})();
