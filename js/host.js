/*
 * クイズパネル ホスト画面
 *
 * トピック {APP_NS}/{参加コード}/...
 *   state  ホスト → 回答者  いまの状態を丸ごと（retain する）
 *   player 回答者 → ホスト  hello / ans / bye（retain しない）
 *   cmd    ホスト → 回答者  rollcall / kick（retain しない）
 */
(function () {
  'use strict';

  var CFG = window.QP_CONFIG;
  var QP = window.QP;
  var NET = window.QP_NET;

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var esc = QP.esc;
  var now = QP.now;

  // ------------------------------------------------------------------
  // データ
  // ------------------------------------------------------------------
  var questions = [];   // [{id, text, type, choices, correct, answer, pts, lim}]
  var session = null;   // {code, gid, created, act}
  var game = { cur: null, final: false, rounds: {}, players: {}, kicked: {} };
  var prefs = { sound: true, playerUrl: '' };
  var recentCodes = [];

  var online = {};      // pid -> {brokerIdx: cid}
  var net = null;
  var netStatus = [];
  var active = false;
  var sessionBusy = false;
  var tab = 'play';
  var stageView = 'board'; // board | rank
  var showAnswer = false;
  var conflictAt = 0;

  // アンケートモード: 正解・○×・得点・順位を使わず、回答を表示するだけ
  function isSurvey() { return prefs.mode === 'survey'; }
  function qLabel(no) { return isSurvey() ? '質問' + no : '第' + no + '問'; }

  function newGame() {
    return { cur: null, final: false, rounds: {}, players: {}, kicked: {} };
  }

  function sampleQuestions() {
    return [
      { id: qid(), type: 'text', text: '日本でいちばん高い山は？', answer: '富士山\nふじさん\n富士', choices: [], correct: [], pts: 10, lim: 30 },
      { id: qid(), type: 'choice', text: '1年でいちばん昼が長い日は？', choices: ['春分', '夏至', '秋分', '冬至'], correct: [1], answer: '', pts: 10, lim: 20 },
      { id: qid(), type: 'text', text: '1ダースはいくつ？（数字で）', answer: '12\n12個\n十二', choices: [], correct: [], pts: 10, lim: 0 },
      { id: qid(), type: 'draw', text: 'パンダの絵を描いてください', answer: '', choices: [], correct: [], pts: 10, lim: 60 }
    ];
  }

  function sampleSurvey() {
    return [
      { id: qid(), type: 'text', text: '好きな食べ物は？', answer: '', choices: [], correct: [], pts: 10, lim: 0 },
      { id: qid(), type: 'choice', text: '今日の気分は？', choices: ['最高！', 'まあまあ', 'ふつう', 'いまいち'], correct: [], answer: '', pts: 10, lim: 0 },
      { id: qid(), type: 'draw', text: 'いまの気持ちを絵で描いてください', answer: '', choices: [], correct: [], pts: 10, lim: 0 }
    ];
  }

  function qid() { return 'q' + NET.randomId(7); }

  function loadAll() {
    questions = QP.store.get('host:questions', null);
    if (!Array.isArray(questions)) questions = sampleQuestions();
    questions = questions.map(fixQuestion).filter(Boolean);
    session = QP.store.get('host:session', null);
    if (!session || !QP.isCode(session.code) || !session.gid) session = null;
    game = QP.store.get('host:game', null);
    if (!game || typeof game !== 'object' || !game.rounds) game = newGame();
    game.players = game.players || {};
    game.kicked = game.kicked || {};
    prefs = QP.store.get('host:prefs', null) || {};
    if (prefs.sound == null) prefs.sound = true;
    if (prefs.mode !== 'survey') prefs.mode = 'quiz';
    recentCodes = QP.store.get('host:recent', []);
    if (!Array.isArray(recentCodes)) recentCodes = [];
    fixCur();
  }

  function fixQuestion(q) {
    if (!q || typeof q !== 'object') return null;
    var type = ['text', 'choice', 'draw'].indexOf(q.type) >= 0 ? q.type : 'text';
    var choices = Array.isArray(q.choices) ? q.choices.map(function (c) { return String(c == null ? '' : c).slice(0, 80); }).slice(0, 6) : [];
    if (type === 'choice' && choices.length < 2) {
      while (choices.length < 2) choices.push('');
    }
    var correct = Array.isArray(q.correct) ? q.correct.filter(function (i) { return Number.isInteger(i) && i >= 0 && i < choices.length; }) : [];
    return {
      id: typeof q.id === 'string' && q.id ? q.id : qid(),
      type: type,
      text: String(q.text == null ? '' : q.text).slice(0, 400),
      answer: String(q.answer == null ? '' : q.answer).slice(0, 400),
      choices: choices,
      correct: correct,
      pts: clampInt(q.pts, 0, 1000, 10),
      lim: clampInt(q.lim, 0, 600, 0)
    };
  }

  function clampInt(v, min, max, def) {
    var n = parseInt(v, 10);
    if (!isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  }

  function fixCur() {
    if (!questions.length) { game.cur = null; return; }
    if (!game.cur || !qById(game.cur)) game.cur = questions[0].id;
  }

  var saveTimer = null;
  function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(saveNow, 300);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!active) return;
    var ok = QP.store.set('host:questions', questions);
    ok = QP.store.set('host:session', session) && ok;
    ok = QP.store.set('host:game', game) && ok;
    ok = QP.store.set('host:prefs', prefs) && ok;
    if (!ok && QP.storageOk && !saveWarned) {
      saveWarned = true;
      QP.toast('ブラウザの保存容量がいっぱいで、状態を保存できませんでした（手書きの回答が多いときに起きます）', 6000);
    }
  }
  var saveWarned = false;

  // ------------------------------------------------------------------
  // 問題とラウンド
  // ------------------------------------------------------------------
  function qById(id) {
    for (var i = 0; i < questions.length; i++) if (questions[i].id === id) return questions[i];
    return null;
  }
  function qIndex(id) {
    for (var i = 0; i < questions.length; i++) if (questions[i].id === id) return i;
    return -1;
  }
  function curQ() { return game.cur ? qById(game.cur) : null; }
  function roundOf(id) {
    if (!game.rounds[id]) game.rounds[id] = { phase: 'waiting', answers: {}, opened: {}, override: {}, dl: 0 };
    return game.rounds[id];
  }
  function curRound() { var q = curQ(); return q ? roundOf(q.id) : null; }
  function curPhase() {
    if (game.final) return 'final';
    var r = curRound();
    return r ? r.phase : 'waiting';
  }

  function playerIds() {
    return Object.keys(game.players).sort(function (a, b) {
      return (game.players[a].joined || 0) - (game.players[b].joined || 0);
    });
  }
  function isOnline(pid) {
    var o = online[pid];
    return !!(o && Object.keys(o).length);
  }

  // 正解の判定。1 = 正解, 0 = 不正解, null = 判定なし（手動判定待ち）
  function autoJudge(q, ans) {
    if (q.type === 'text') {
      var list = QP.splitAnswers(q.answer);
      if (!list.length) return null;
      if (!ans) return 0;
      return QP.textMatches(ans.v, list) ? 1 : 0;
    }
    if (q.type === 'choice') {
      if (!q.correct.length) return null;
      if (!ans) return 0;
      return q.correct.indexOf(ans.v) >= 0 ? 1 : 0;
    }
    if (q.type === 'draw') return ans ? null : 0;
    return null;
  }
  function judgeOf(q, r, pid) {
    if (r.override && Object.prototype.hasOwnProperty.call(r.override, pid)) return r.override[pid];
    return autoJudge(q, r.answers[pid]);
  }

  function scores() {
    var sc = {};
    var ids = playerIds();
    ids.forEach(function (pid) { sc[pid] = 0; });
    questions.forEach(function (q) {
      var r = game.rounds[q.id];
      if (!r || r.phase !== 'judged') return;
      ids.forEach(function (pid) {
        if (judgeOf(q, r, pid) === 1) sc[pid] += q.pts || 0;
      });
    });
    return sc;
  }

  function correctDisplay(q) {
    if (!q) return '';
    if (q.type === 'choice') {
      return q.correct.map(function (i) { return QP.choiceLabel(i) + '. ' + (q.choices[i] || ''); }).join(' ／ ');
    }
    var list = QP.splitAnswers(q.answer);
    return list.length ? list[0] : '';
  }

  function answerText(q, a) {
    if (!a) return '';
    if (q.type === 'choice') return QP.choiceLabel(a.v) + '. ' + (q.choices[a.v] || '');
    if (q.type === 'draw') return '（手書き）';
    return String(a.v);
  }

  // ------------------------------------------------------------------
  // 通信
  // ------------------------------------------------------------------
  function topics() {
    return {
      state: QP.topic(session.code, 'state'),
      player: QP.topic(session.code, 'player'),
      cmd: QP.topic(session.code, 'cmd')
    };
  }
  function subsFor(code) {
    return [
      { topic: QP.topic(code, 'player'), qos: 1 },
      { topic: QP.topic(code, 'state'), qos: 1 }
    ];
  }

  function buildState() {
    var q = curQ();
    var r = q ? roundOf(q.id) : null;
    var phase = curPhase();
    var ids = playerIds();
    var st = {
      v: 1,
      gid: session.gid,
      ts: now(),
      act: session.act,
      ph: phase,
      total: questions.length,
      pl: ids
    };
    if (isSurvey()) st.mode = 'survey';
    else st.sc = scores();
    if (q) {
      st.q = { id: q.id, no: qIndex(q.id) + 1 };
      if (phase === 'open' || phase === 'closed' || phase === 'judged') {
        st.q.r = r.openedAt || 1;
        st.q.text = q.text;
        st.q.type = q.type;
        if (!isSurvey()) st.q.pts = q.pts;
        if (q.type === 'choice') st.q.ch = q.choices;
      }
    }
    if (r && (phase === 'open' || phase === 'closed' || phase === 'judged')) {
      st.got = {};
      Object.keys(r.answers).forEach(function (pid) {
        if (game.players[pid]) st.got[pid] = r.answers[pid].s;
      });
    }
    if (r && phase === 'open' && r.dl) {
      st.dl = r.dl;
      st.rem = Math.max(0, r.dl - now());
    }
    if (r && phase === 'judged' && !isSurvey()) {
      st.res = {};
      ids.forEach(function (pid) {
        var j = judgeOf(q, r, pid);
        if (j === 0 || j === 1) st.res[pid] = j;
      });
      st.ca = correctDisplay(q);
    }
    return st;
  }

  var pubTimer = null;
  var lastPub = 0;
  function schedulePublish(delay) {
    if (pubTimer) return;
    pubTimer = setTimeout(publishNow, delay == null ? 200 : delay);
  }
  function publishNow() {
    clearTimeout(pubTimer);
    pubTimer = null;
    if (!session || !net || !active || sessionBusy) return;
    lastPub = now();
    net.publish(topics().state, JSON.stringify(buildState()), { qos: 1, retain: true });
  }

  function onConnect(idx) {
    if (!session || sessionBusy) return;
    // つながるたびに最新の状態を置き直し、全員に名乗り直してもらう
    net.publishTo(idx, topics().state, JSON.stringify(buildState()), { qos: 1, retain: true });
    net.publishTo(idx, topics().cmd, JSON.stringify({ t: 'rollcall', gid: session.gid }), { qos: 0 });
  }

  function onDown(idx) {
    Object.keys(online).forEach(function (pid) {
      if (online[pid]) delete online[pid][idx];
    });
    renderSoon('board', 'players', 'header');
  }

  function onStatus(list) {
    netStatus = list;
    renderSoon('header', 'settings');
  }

  function onMessage(topic, text, idx, packet) {
    if (!session || sessionBusy || !active) return;
    var t = topics();
    if (topic === t.player) {
      handlePlayer(text, idx);
    } else if (topic === t.state) {
      var m = QP.parse(text);
      if (m && m.gid && m.gid !== session.gid && !packet.retain) {
        conflictAt = now();
        renderSoon('header');
      }
    }
  }

  function cleanName(s) {
    s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return s.slice(0, CFG.MAX_NAME_LEN) || 'ゲスト';
  }

  var helloPubAt = 0;
  function handlePlayer(text, idx) {
    var m = QP.parse(text);
    if (!m || typeof m.pid !== 'string' || !/^[a-z0-9]{4,24}$/.test(m.pid)) return;
    var pid = m.pid;
    var cid = typeof m.cid === 'string' ? m.cid.slice(0, 40) : '';

    if (m.t === 'bye') {
      var o = online[pid];
      if (o && o[idx] === cid) {
        delete o[idx];
        renderSoon('board', 'players', 'header');
      }
      return;
    }
    if (m.t !== 'hello' && m.t !== 'ans') return;

    if (game.kicked[pid]) {
      sendKick(pid);
      return;
    }

    var changed = false;
    var p = game.players[pid];
    var name = cleanName(m.name);
    if (!p) {
      p = game.players[pid] = { name: name, joined: now() };
      changed = true;
      Sound.play('join');
      QP.toast(name + ' さんが参加しました');
    } else if (name && p.name !== name) {
      p.name = name;
      changed = true;
    }
    p.seen = now();
    if (!online[pid]) online[pid] = {};
    online[pid][idx] = cid;

    if (m.a && acceptAnswer(pid, m.a)) changed = true;

    if (changed) {
      saveSoon();
      schedulePublish();
    } else if (m.t === 'hello' && now() - helloPubAt > 2000) {
      // 名乗り直しに対しては、最新の状態をもう一度置く（取りこぼした回答者のため）
      helloPubAt = now();
      schedulePublish(400);
    }
    renderSoon('board', 'players', 'header', 'progress');
  }

  function validateAnswer(q, v) {
    if (q.type === 'text') {
      if (typeof v !== 'string') return undefined;
      v = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CFG.MAX_TEXT_LEN);
      return v ? v : undefined;
    }
    if (q.type === 'choice') {
      return Number.isInteger(v) && v >= 0 && v < q.choices.length ? v : undefined;
    }
    if (q.type === 'draw') {
      if (!QP.validDraw(v) || QP.drawIsEmpty(v)) return undefined;
      return { s: v.s };
    }
    return undefined;
  }

  function acceptAnswer(pid, a) {
    var q = curQ();
    var r = curRound();
    if (!q || !r || r.phase !== 'open' || game.final) return false;
    if (!a || a.q !== q.id || a.r !== (r.openedAt || 1)) return false;
    var s = Number(a.s);
    if (!isFinite(s)) return false;
    if (r.dl && now() > r.dl + 500) return false;
    var v = validateAnswer(q, a.v);
    if (v === undefined) return false;
    var prev = r.answers[pid];
    if (prev && prev.s >= s) return false;
    r.answers[pid] = { v: v, s: s, at: now() };
    session.act = now();
    return true;
  }

  var kickAt = {};
  function sendKick(pid) {
    if (kickAt[pid] && now() - kickAt[pid] < 3000) return;
    kickAt[pid] = now();
    net.publish(topics().cmd, JSON.stringify({ t: 'kick', pid: pid, gid: session.gid }), { qos: 1 });
  }

  function rollcall() {
    net.publish(topics().cmd, JSON.stringify({ t: 'rollcall', gid: session.gid }), { qos: 0 });
    QP.toast('全員に名乗り直しを依頼しました');
  }

  // ------------------------------------------------------------------
  // 参加コード
  // ------------------------------------------------------------------
  function randomCode() {
    for (var i = 0; i < 50; i++) {
      var buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      var c = String(100000 + (buf[0] % 900000));
      if (recentCodes.indexOf(c) < 0) return c;
    }
    return String(100000 + Math.floor(Math.random() * 900000));
  }

  function newSession() {
    if (sessionBusy) return Promise.resolve();
    sessionBusy = true;
    var old = session;
    renderAll();
    return net.waitAny(8000).then(function () {
      // 古いコードの保持データを空にする（古いコードにつながっていた回答者は参加画面に戻る）
      if (old) net.publish(QP.topic(old.code, 'state'), '', { qos: 1, retain: true });
      var tries = 0;
      function attempt() {
        var c = randomCode();
        tries++;
        if (net.connectedCount() === 0 || tries > CFG.CODE_CHECK_MAX_TRY) return Promise.resolve(c);
        return net.peek(QP.topic(c, 'state'), CFG.CODE_CHECK_WAIT_MS).then(function (got) {
          var used = got.some(function (t) { return t && t.length > 0; });
          if (!used) return c;
          recentCodes.push(c);
          return attempt();
        });
      }
      return attempt();
    }).then(function (code) {
      recentCodes.push(code);
      if (recentCodes.length > CFG.RECENT_CODES_MAX) recentCodes = recentCodes.slice(-CFG.RECENT_CODES_MAX);
      QP.store.set('host:recent', recentCodes);
      var keepCur = game ? game.cur : null;
      session = { code: code, gid: NET.randomId(10), created: now(), act: now() };
      game = newGame();
      game.cur = keepCur;
      fixCur();
      online = {};
      net.setSubscriptions(subsFor(code));
      sessionBusy = false;
      conflictAt = 0;
      saveNow();
      publishNow();
      setTimeout(function () {
        net.publish(topics().cmd, JSON.stringify({ t: 'rollcall', gid: session.gid }), { qos: 0 });
      }, 500);
      renderAll();
    });
  }

  function checkExpiry() {
    if (!session || sessionBusy) return;
    if (now() - (session.act || session.created || 0) > QP.TTL_MS) {
      QP.toast('長い時間操作がなかったため、新しい参加コードに切り替えました', 5000);
      newSession();
    }
  }

  // ------------------------------------------------------------------
  // 進行の操作
  // ------------------------------------------------------------------
  function commit() {
    if (session) session.act = now();
    saveSoon();
    publishNow();
    renderAll();
  }

  function openQuestion() {
    var q = curQ();
    if (!q) return;
    var r = roundOf(q.id);
    if (r.phase !== 'waiting') return;
    r.phase = 'open';
    r.answers = {};
    r.opened = {};
    r.override = {};
    r.openedAt = now();
    r.dl = q.lim > 0 ? now() + q.lim * 1000 : 0;
    lastTick = -1;
    game.final = false;
    stageView = 'board';
    Sound.play('start');
    commit();
  }

  function closeAnswers(auto) {
    var r = curRound();
    if (!r || r.phase !== 'open') return;
    r.phase = 'closed';
    r.dl = 0;
    r.closedAt = now();
    Sound.play(auto ? 'timeup' : 'close');
    commit();
  }

  function openPanel(pid) {
    var r = curRound();
    if (!r || (r.phase !== 'closed' && r.phase !== 'judged')) return;
    if (r.opened[pid]) return;
    r.opened[pid] = 1;
    Sound.play('flip');
    saveSoon();
    renderSoon('board', 'control');
  }

  function openNext() {
    var r = curRound();
    if (!r) return;
    var ids = playerIds();
    for (var i = 0; i < ids.length; i++) {
      if (!r.opened[ids[i]]) { openPanel(ids[i]); return; }
    }
  }

  function openAll() {
    var r = curRound();
    if (!r || (r.phase !== 'closed' && r.phase !== 'judged')) return;
    var any = false;
    playerIds().forEach(function (pid) {
      if (!r.opened[pid]) { r.opened[pid] = 1; any = true; }
    });
    if (any) Sound.play('flip');
    saveSoon();
    renderSoon('board', 'control');
  }

  function announce() {
    if (isSurvey()) return;
    var q = curQ();
    var r = curRound();
    if (!q || !r || r.phase !== 'closed') return;
    playerIds().forEach(function (pid) { r.opened[pid] = 1; });
    r.phase = 'judged';
    r.judgedAt = now();
    stampWave = now();
    var anyOk = playerIds().some(function (pid) { return judgeOf(q, r, pid) === 1; });
    Sound.play(anyOk ? 'correct' : 'wrong');
    commit();
  }

  function toggleJudge(pid) {
    if (isSurvey()) return;
    var q = curQ();
    var r = curRound();
    if (!q || !r || r.phase !== 'judged') return;
    var j = judgeOf(q, r, pid);
    r.override[pid] = j === 1 ? 0 : 1;
    Sound.play(r.override[pid] === 1 ? 'ok1' : 'ng1');
    commit();
  }

  function setCur(id) {
    var r = curRound();
    if (r && r.phase === 'open') {
      r.phase = 'closed';
      r.dl = 0;
    }
    game.cur = id;
    game.final = false;
    stageView = 'board';
    showAnswer = false;
    commit();
  }

  function moveQ(delta) {
    var i = qIndex(game.cur);
    var j = i + delta;
    if (j < 0 || j >= questions.length) return;
    var r = curRound();
    if (r && r.phase === 'open') {
      ask('回答を受け付けています。締め切って移動しますか？', '締め切って移動').then(function (ok) {
        if (ok) setCur(questions[j].id);
      });
      return;
    }
    setCur(questions[j].id);
  }

  function redoRound() {
    var q = curQ();
    if (!q) return;
    ask(qLabel(qIndex(q.id) + 1) + 'の回答と判定を消して、出題前に戻しますか？', '出題前に戻す').then(function (ok) {
      if (!ok) return;
      game.rounds[q.id] = { phase: 'waiting', answers: {}, opened: {}, override: {}, dl: 0 };
      commit();
    });
  }

  function showFinal() {
    if (isSurvey()) return;
    var r = curRound();
    if (r && r.phase === 'open') {
      r.phase = 'closed';
      r.dl = 0;
    }
    game.final = true;
    stageView = 'rank';
    rankWave = now();
    Sound.play('fanfare');
    commit();
  }

  function hideFinal() {
    game.final = false;
    stageView = 'board';
    commit();
  }

  function toggleRank() {
    if (game.final) { hideFinal(); return; }
    if (isSurvey()) return;
    stageView = stageView === 'rank' ? 'board' : 'rank';
    rankWave = stageView === 'rank' ? now() : 0;
    renderControl();
  }

  function primaryAction() {
    var phase = curPhase();
    var r = curRound();
    if (phase === 'waiting') return openQuestion();
    if (phase === 'open') return closeAnswers(false);
    if (phase === 'closed') {
      var ids = playerIds();
      var unopened = ids.filter(function (pid) { return !r.opened[pid]; });
      if (unopened.length) return openNext();
      if (isSurvey()) return moveQ(1);
      return announce();
    }
    if (phase === 'judged') {
      var i = qIndex(game.cur);
      if (i < questions.length - 1) return moveQ(1);
      return showFinal();
    }
  }

  function primaryLabel() {
    var phase = curPhase();
    var r = curRound();
    if (!curQ()) return '';
    if (phase === 'waiting') return '出題する';
    if (phase === 'open') return '締め切る';
    if (phase === 'closed') {
      var unopened = playerIds().filter(function (pid) { return !r.opened[pid]; });
      if (unopened.length) return '次のパネルを開く';
      if (isSurvey()) return qIndex(game.cur) < questions.length - 1 ? '次の質問へ' : '';
      return '正解発表';
    }
    if (phase === 'judged') {
      if (qIndex(game.cur) < questions.length - 1) return isSurvey() ? '次の質問へ' : '次の問題へ';
      return isSurvey() ? '' : '最終結果発表';
    }
    return '';
  }

  // 制限時間
  var lastTick = -1;
  function tick() {
    var r = curRound();
    if (r && r.phase === 'open' && r.dl && !game.final) {
      var remain = r.dl - now();
      var sec = Math.ceil(remain / 1000);
      if (remain <= 0) {
        closeAnswers(true);
        return;
      }
      if (sec !== lastTick) {
        lastTick = sec;
        if (sec <= 5) Sound.play('tick');
        renderTimer();
      }
    }
  }

  // ------------------------------------------------------------------
  // 効果音（Web Audio で合成）
  // ------------------------------------------------------------------
  var Sound = (function () {
    var ctx = null;
    function ac() {
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { ctx = new AC(); } catch (e) { return null; }
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function tone(a, f0, t0, dur, type, gain, f1) {
      var o = a.createOscillator();
      var g = a.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(f0, a.currentTime + t0);
      if (f1) o.frequency.exponentialRampToValueAtTime(f1, a.currentTime + t0 + dur);
      g.gain.setValueAtTime(0.0001, a.currentTime + t0);
      g.gain.exponentialRampToValueAtTime(gain || 0.2, a.currentTime + t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + t0 + dur);
      o.connect(g);
      g.connect(a.destination);
      o.start(a.currentTime + t0);
      o.stop(a.currentTime + t0 + dur + 0.05);
    }
    return {
      play: function (name) {
        if (!prefs || !prefs.sound) return;
        var a = ac();
        if (!a) return;
        switch (name) {
          case 'start': tone(a, 880, 0, 0.14, 'triangle', 0.25); tone(a, 1320, 0.13, 0.3, 'triangle', 0.25); break;
          case 'close': tone(a, 700, 0, 0.35, 'square', 0.08, 350); break;
          case 'timeup': tone(a, 220, 0, 0.6, 'square', 0.12); tone(a, 233, 0, 0.6, 'square', 0.08); break;
          case 'flip': tone(a, 420, 0, 0.09, 'sine', 0.25, 980); break;
          case 'correct': tone(a, 1318.5, 0, 0.35, 'sine', 0.3); tone(a, 1046.5, 0.32, 0.9, 'sine', 0.3); break;
          case 'wrong': tone(a, 140, 0, 0.7, 'square', 0.12); tone(a, 147, 0, 0.7, 'sawtooth', 0.06); break;
          case 'ok1': tone(a, 1318.5, 0, 0.12, 'sine', 0.2); tone(a, 1046.5, 0.1, 0.3, 'sine', 0.2); break;
          case 'ng1': tone(a, 160, 0, 0.3, 'square', 0.1); break;
          case 'tick': tone(a, 1500, 0, 0.05, 'sine', 0.15); break;
          case 'join': tone(a, 760, 0, 0.08, 'sine', 0.12); tone(a, 1140, 0.07, 0.12, 'sine', 0.1); break;
          case 'fanfare':
            [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) { tone(a, f, i * 0.12, 0.3, 'triangle', 0.22); });
            tone(a, 1046.5, 0.5, 0.9, 'triangle', 0.22); tone(a, 1318.5, 0.5, 0.9, 'triangle', 0.15);
            break;
        }
      }
    };
  })();

  // ------------------------------------------------------------------
  // 画面
  // ------------------------------------------------------------------
  var dirty = {};
  var renderTimer2 = null;
  function renderSoon() {
    for (var i = 0; i < arguments.length; i++) dirty[arguments[i]] = true;
    if (renderTimer2) return;
    renderTimer2 = requestAnimationFrame(function () {
      renderTimer2 = null;
      var d = dirty;
      dirty = {};
      if (d.all) return renderAll();
      if (d.header) renderHeader();
      if (d.control) renderControl();
      else if (d.progress) renderProgress();
      if (d.board && !d.control) renderStage();
      if (d.players && tab === 'players') renderPlayers();
      if (d.settings && tab === 'settings') renderSettings();
    });
  }

  function renderAll() {
    renderHeader();
    renderTabs();
    renderControl();
    if (tab === 'questions') renderQuestions();
    if (tab === 'players') renderPlayers();
    if (tab === 'settings') renderSettings();
  }

  function playerBaseUrl() {
    if (prefs.playerUrl) return prefs.playerUrl;
    if (CFG.PLAYER_URL) return CFG.PLAYER_URL;
    // GitHub Pages では https://<ユーザー名>.github.io/panel-host/ の隣の Answer/（CFG.PLAYER_REPO）を使う
    // （開発用のフォルダ構成 host/ と player/ のときは player/）
    var dir = /\/host\/(index\.html)?$/.test(location.pathname) ? 'player' : CFG.PLAYER_REPO;
    return new URL('../' + dir + '/', location.href).href;
  }
  function joinUrl() {
    var base = playerBaseUrl();
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'code=' + (session ? session.code : '');
  }

  function renderHeader() {
    $('#code').textContent = session && !sessionBusy ? QP.formatCode(session.code) : '準備中…';
    $('#modeBadge').textContent = isSurvey() ? 'アンケート' : 'クイズ';
    $('#modeBadge').className = 'mode-badge' + (isSurvey() ? ' survey' : '');
    var up = netStatus.filter(function (s) { return s.state === 'connected'; }).length;
    var lamps = netStatus.map(function (s) {
      return '<span class="lamp-dot ' + s.state + '" title="' + esc(s.name + '：' + stateLabel(s.state)) + '"></span>';
    }).join('');
    $('#netinfo').innerHTML = '<div class="net-lamps">' + lamps + '</div><div class="net-text ' + (up ? 'ok' : 'ng') + '">' +
      (up ? 'サーバー ' + up + '/' + netStatus.length + ' 接続' : '接続を試しています…') + '</div>';
    var ids = playerIds();
    var on = ids.filter(isOnline).length;
    $('#counts').innerHTML = '<b>' + ids.length + '</b> 人参加<small>（接続中 ' + on + '）</small>';
    var warn = $('#warnbar');
    var msgs = [];
    if (conflictAt && now() - conflictAt < 60000) {
      msgs.push('同じ参加コードを別のホストが使っているようです。<button data-act="newcode">新しいコードに変更</button>');
    }
    if (!QP.storageOk) msgs.push('このブラウザでは状態を保存できません（プライベートブラウズなど）。再読み込みすると内容が消えます。');
    warn.innerHTML = msgs.map(function (m) { return '<div>' + m + '</div>'; }).join('');
    warn.hidden = !msgs.length;
  }

  function stateLabel(s) {
    return { connected: '接続中', connecting: '接続しています', offline: '切断（再接続待ち）', error: 'エラー' }[s] || s;
  }

  function renderTabs() {
    $$('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === tab); });
    $$('main > section').forEach(function (s) { s.hidden = s.id !== 'tab-' + tab; });
    document.body.dataset.tab = tab;
  }

  var PHASE_LABEL = { waiting: '出題前', open: '回答受付中', closed: '締め切り', judged: '正解発表', final: '最終結果' };

  function renderControl() {
    var el = $('#control');
    var q = curQ();
    if (!q) {
      el.innerHTML = '<div class="ctl-empty">問題がまだありません。<button data-act="goto-questions" class="btn primary">問題を作る</button></div>' +
        '<div class="ctl-sub">' + boardButtonHtml() + '</div>';
      renderStage();
      return;
    }
    var phase = curPhase();
    var i = qIndex(q.id);
    var opts = questions.map(function (qq, k) {
      var r = game.rounds[qq.id];
      var mark = r && r.phase === 'judged' ? '✓ ' : (r && r.phase !== 'waiting' ? '… ' : '');
      return '<option value="' + qq.id + '"' + (qq.id === q.id ? ' selected' : '') + '>' + mark + '第' + (k + 1) + '問 ' +
        esc(qq.text.slice(0, 24) || '（問題文なし）') + '</option>';
    }).join('');

    var html = '';
    html += '<div class="ctl-nav"><button class="btn icon" data-act="prev" title="前の問題（←）"' + (i <= 0 ? ' disabled' : '') + '>◀</button>' +
      '<select id="qSelect">' + opts + '</select>' +
      '<button class="btn icon" data-act="next" title="次の問題（→）"' + (i >= questions.length - 1 ? ' disabled' : '') + '>▶</button></div>';
    html += '<div class="ctl-phase ph-' + phase + '">' + PHASE_LABEL[phase] + '</div>';
    html += '<div class="ctl-qcard"><div class="ctl-qno">' + qLabel(i + 1) + ' <small>' + typeLabel(q.type) + (isSurvey() ? '' : '・' + q.pts + '点') +
      (q.lim ? '・' + q.lim + '秒' : '') + '</small></div>';
    html += '<div class="ctl-qtext">' + (esc(q.text) || '<span class="muted">（問題文なし）</span>') + '</div>';
    if (q.type === 'choice') {
      html += '<ol class="ctl-choices">' + q.choices.map(function (c, k) {
        return '<li><b>' + QP.choiceLabel(k) + '</b> ' + esc(c) + '</li>';
      }).join('') + '</ol>';
    }
    var cd = correctDisplay(q);
    if (!isSurvey()) html += '<div class="ctl-answer">' + (showAnswer
      ? '<div class="ans-reveal"><small>正解</small> ' + (cd ? esc(cd) : '<span class="muted">未設定（手動で判定）</span>') +
        (q.type === 'text' && QP.splitAnswers(q.answer).length > 1 ? '<div class="muted small">別解: ' + esc(QP.splitAnswers(q.answer).slice(1).join('、')) + '</div>' : '') +
        ' <button class="link" data-act="toggle-answer">隠す</button></div>'
      : '<button class="link" data-act="toggle-answer">正解を見る（この画面だけに表示）</button>') + '</div>';
    html += '</div>';

    html += '<div class="ctl-progress" id="ctlProgress"></div>';

    html += '<div class="ctl-actions">';
    var label = primaryLabel();
    if (phase === 'final') {
      html += '<button class="btn big" data-act="hide-final">パネル表示に戻る</button>';
    } else {
      if (label) html += '<button class="btn big primary" data-act="primary">' + label + ' <kbd>Space</kbd></button>';
      if (phase === 'closed') {
        html += '<div class="row"><button class="btn" data-act="open-all">一斉オープン <kbd>A</kbd></button>' +
          (isSurvey() ? '' : '<button class="btn" data-act="announce">正解発表 <kbd>J</kbd></button>') + '</div>';
      }
      if (phase === 'judged' && !isSurvey()) {
        html += '<div class="hint">パネルをクリックすると ○ と × を切り替えられます</div>';
      }
    }
    html += '</div>';

    html += '<div class="ctl-sub">';
    html += '<button class="btn small" data-act="present">全画面で表示 <kbd>F</kbd></button>';
    html += boardButtonHtml();
    if (!isSurvey()) {
      html += '<button class="btn small" data-act="toggle-rank">' + (stageView === 'rank' && !game.final ? 'パネルに戻る' : '順位を表示') + ' <kbd>R</kbd></button>';
      if (phase !== 'final') html += '<button class="btn small" data-act="final">最終結果発表</button>';
    }
    if (phase !== 'waiting' && phase !== 'final') html += '<button class="btn small ghost" data-act="redo">この問題をやり直す</button>';
    html += '<button class="btn small ghost" data-act="sound">' + (prefs.sound ? '🔊 効果音あり' : '🔇 効果音なし') + '</button>';
    html += '</div>';
    html += isSurvey()
      ? '<div class="ctl-keys">アンケートモード（正解・得点なし）／ キー操作：Space 次へ ／ A 一斉オープン ／ ← → 質問の切替 ／ F 全画面</div>'
      : '<div class="ctl-keys">キー操作：Space 次へ ／ A 一斉オープン ／ J 正解発表 ／ ← → 問題の切替 ／ R 順位 ／ F 全画面</div>';

    el.innerHTML = html;
    renderProgress();
    renderStage();
    renderPresentBar();
  }

  function boardButtonHtml() {
    var n = boardCount();
    return '<button class="btn small' + (n ? ' on' : '') + '" data-act="open-board" title="パネルだけを表示するページを別ウィンドウで開きます（画面共有用）">' +
      '表示用ページを開く' + (n ? '<span class="board-on">● 表示中</span>' : '') + '</button>';
  }

  function typeLabel(t) { return { text: '記述', choice: '選択式', draw: '手書き' }[t] || t; }

  function renderProgress() {
    var el = $('#ctlProgress');
    if (!el) return;
    var q = curQ();
    var r = curRound();
    var phase = curPhase();
    if (!q || !r || phase === 'waiting' || phase === 'final') { el.innerHTML = ''; return; }
    var ids = playerIds();
    var n = ids.filter(function (pid) { return r.answers[pid]; }).length;
    var html = '<div class="prog-count"><b>' + n + '</b> / ' + ids.length + ' 人が回答</div>';
    if (phase === 'open' && r.dl) {
      html += '<div class="prog-timer" id="ctlTimer"></div>';
    }
    if (phase === 'judged') {
      var ok = ids.filter(function (pid) { return judgeOf(q, r, pid) === 1; }).length;
      html += '<div class="prog-count">正解 <b>' + ok + '</b> 人</div>';
    }
    el.innerHTML = html;
    renderTimer();
  }

  function renderTimer() {
    var r = curRound();
    var remain = r && r.phase === 'open' && r.dl ? Math.max(0, Math.ceil((r.dl - now()) / 1000)) : null;
    var el = $('#ctlTimer');
    if (el) {
      el.textContent = remain == null ? '' : remain;
      el.classList.toggle('hurry', remain != null && remain <= 5);
    }
    if (stage) stage.tick();
  }

  // ---- パネル表示（描画は js/stage.js。表示用ページ board.html にも同じものを送る） ----
  var stage = null;
  var stampWave = 0;
  var rankWave = 0;

  // ステージに渡す表示用データ。回答の中身は開いたパネルの分だけ入れる
  function buildView() {
    var q = curQ();
    var r = curRound();
    var phase = curPhase();
    var sc = scores();
    var v = {
      code: session ? session.code : '',
      busy: sessionBusy || !session,
      joinUrl: session ? joinUrl() : '',
      survey: isSurvey(),
      // まだ一度も出題していない間は、表示用ページなどに参加コードと QR コードを出し続ける
      lobby: !game.final && !questions.some(function (qq) {
        var rr = game.rounds[qq.id];
        return rr && rr.phase !== 'waiting';
      }),
      phase: phase,
      view: stageView,
      final: !!game.final,
      q: null,
      dl: 0,
      correctText: '',
      counts: null,
      stampWave: stampWave,
      rankWave: rankWave,
      players: []
    };
    if (q) {
      v.q = {
        id: q.id,
        no: qIndex(q.id) + 1,
        type: q.type,
        text: phase === 'waiting' ? '' : q.text,
        choices: q.type === 'choice' ? q.choices.slice() : [],
        correct: phase === 'judged' ? q.correct.slice() : []
      };
      if (r && phase === 'open' && r.dl) v.dl = r.dl;
      // 選択式の人数: クイズは正解発表のとき、アンケートは全員のパネルを開いたとき
      var allOpen = r && (phase === 'closed' || phase === 'judged') && playerIds().every(function (pid) { return r.opened[pid]; });
      if (r && (isSurvey() ? allOpen : phase === 'judged')) {
        if (!isSurvey()) v.correctText = correctDisplay(q);
        if (q.type === 'choice') {
          v.counts = q.choices.map(function () { return 0; });
          playerIds().forEach(function (pid) {
            var a = r.answers[pid];
            if (a && v.counts[a.v] != null) v.counts[a.v]++;
          });
        }
      }
    }
    playerIds().forEach(function (pid) {
      var a = r && phase !== 'waiting' && phase !== 'final' ? r.answers[pid] : null;
      var opened = !!(r && (phase === 'closed' || phase === 'judged') && r.opened[pid]);
      v.players.push({
        pid: pid,
        name: game.players[pid].name,
        score: sc[pid] || 0,
        online: isOnline(pid),
        answered: !!a,
        opened: opened,
        click: !!(r && ((phase === 'closed' && !opened) || (phase === 'judged' && !isSurvey()))),
        ans: opened && a ? { k: q.id + ':' + a.s, v: a.v } : null,
        j: q && r && phase === 'judged' && !isSurvey() ? judgeOf(q, r, pid) : null
      });
    });
    return v;
  }

  function renderStage() {
    if (!stage) return;
    var v = buildView();
    stage.render(v);
    sendToBoards(v);
  }

  // ---- 表示用ページ（画面共有用）との連絡 ----
  // 同じブラウザで開いた board.html に BroadcastChannel で表示用データを送る
  var boardCh = null;
  var boards = {};       // 表示用ページの id -> 最後に連絡があった時刻
  var boardSentAt = 0;
  var boardTimer = null;

  function boardCount() {
    var t = now();
    return Object.keys(boards).filter(function (id) { return t - boards[id] < 6000; }).length;
  }

  function sendToBoards(v, force) {
    if (!boardCh || !active || (!force && !boardCount())) return;
    // 短い間に何度も描き直したときは、まとめて送る
    var wait = 80 - (now() - boardSentAt);
    if (wait > 0 && !force) {
      if (!boardTimer) boardTimer = setTimeout(function () { boardTimer = null; sendToBoards(buildView(), true); }, wait);
      return;
    }
    boardSentAt = now();
    try { boardCh.postMessage({ t: 'view', view: v || buildView() }); } catch (e) { /* ignore */ }
  }

  function setupBoardChannel() {
    if (!('BroadcastChannel' in window)) return;
    boardCh = new BroadcastChannel('quizpanel-board');
    boardCh.onmessage = function (e) {
      var m = e.data || {};
      if (!active || typeof m.id !== 'string') return;
      if (m.t === 'hello' || m.t === 'ping') {
        var isNew = !boards[m.id] || now() - boards[m.id] >= 6000;
        boards[m.id] = now();
        if (m.t === 'hello' || isNew) {
          sendToBoards(buildView(), true);
          renderSoon('control');
        }
      } else if (m.t === 'bye') {
        delete boards[m.id];
        renderSoon('control');
      } else if (m.t === 'click' && typeof m.pid === 'string') {
        boards[m.id] = now();
        handlePanelClick(m.pid);
      } else if (m.t === 'key' && typeof m.key === 'string') {
        boards[m.id] = now();
        handleKey(m.key);
      }
    };
    // 生きていることを知らせる（表示用ページはこれが途切れると「ホスト画面が見つかりません」と出す）
    var lastCount = 0;
    setInterval(function () {
      var c = boardCount();
      if (c) sendToBoards(buildView(), true);
      if (c !== lastCount) { lastCount = c; renderSoon('control'); }
    }, 2000);
  }

  function openBoardWindow() {
    var w = window.open('board.html', 'quizpanel-board', 'popup=yes,width=1280,height=760');
    if (!w) {
      QP.toast('ポップアップがブロックされました。board.html を別のタブで開いてください', 5000);
      return;
    }
    try { w.focus(); } catch (e) { /* ignore */ }
  }

  function handlePanelClick(pid) {
    var phase = curPhase();
    var r = curRound();
    if (!r || !game.players[pid]) return;
    if (!r.opened[pid] && (phase === 'closed' || phase === 'judged')) openPanel(pid);
    else if (phase === 'judged') toggleJudge(pid);
  }

  function showJoinModal() {
    openModal('<div class="modal-join">' + QP.joinCardHtml(session && session.code, joinUrl(), sessionBusy || !session, true) +
      '<div class="modal-actions"><button class="btn" data-act="copy-url">URLをコピー</button>' +
      '<button class="btn primary" data-act="close-modal">閉じる</button></div></div>', 'wide');
    if (session && !sessionBusy) QP.renderQr($('#modal .join-qr'), joinUrl(), 8);
  }

  // ---- 全画面 ----
  var presenting = false;
  function setPresenting(on) {
    presenting = on;
    document.body.classList.toggle('presenting', on);
    if (on) {
      tab = 'play';
      renderTabs();
      var de = document.documentElement;
      if (de.requestFullscreen && !document.fullscreenElement) de.requestFullscreen().catch(function () { /* ignore */ });
    } else if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(function () { /* ignore */ });
    }
    setTimeout(function () { renderStage(); if (stage) stage.relayout(); }, 60);
    renderPresentBar();
  }

  function renderPresentBar() {
    var el = $('#presentBar');
    if (!presenting) { el.innerHTML = ''; return; }
    var phase = curPhase();
    var label = primaryLabel();
    var html = '';
    if (phase === 'final') html += '<button class="btn" data-act="hide-final">パネルに戻る</button>';
    else if (label) html += '<button class="btn primary" data-act="primary">' + label + '</button>';
    if (phase === 'closed') html += '<button class="btn" data-act="open-all">一斉オープン</button>' + (isSurvey() ? '' : '<button class="btn" data-act="announce">正解発表</button>');
    if (!isSurvey()) html += '<button class="btn" data-act="toggle-rank">' + (stageView === 'rank' && !game.final ? 'パネル' : '順位') + '</button>';
    html += '<button class="btn ghost" data-act="present-off">全画面を終了</button>';
    el.innerHTML = html;
  }

  var idleTimer = null;
  function pokeIdle() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { document.body.classList.add('idle'); }, 2500);
  }

  // ---- 問題の編集 ----
  function renderQuestions() {
    var el = $('#tab-questions');
    var html = '<div class="q-toolbar">' +
      '<button class="btn primary" data-act="q-add">＋ 問題を追加</button>' +
      '<button class="btn" data-act="q-export">書き出し（JSON）</button>' +
      '<label class="btn">読み込み（JSON）<input type="file" accept=".json,application/json" id="qImport" hidden></label>' +
      '<button class="btn ghost" data-act="q-sample">サンプルを追加</button>' +
      '<button class="btn ghost danger" data-act="q-clear">すべて削除</button>' +
      '</div>';
    html += isSurvey()
      ? '<p class="muted small">アンケートモードです。正解と配点は使わず、回答をパネルに表示するだけです（設定タブでクイズモードに戻せます）。入力した内容は自動で保存されます。</p>'
      : '<p class="muted small">入力した内容は自動で保存されます。記述問題の正解は、改行で区切ると別解も正解にできます（全角・半角、ひらがな・カタカナ、大文字・小文字、空白の違いは同じとみなします）。</p>';
    if (!questions.length) {
      html += '<div class="q-empty">問題がありません。「＋ 問題を追加」から作りましょう。</div>';
    }
    html += questions.map(function (q, i) { return questionCardHtml(q, i); }).join('');
    if (questions.length) html += '<div class="q-toolbar"><button class="btn primary" data-act="q-add">＋ 問題を追加</button></div>';
    el.innerHTML = html;
  }

  function questionCardHtml(q, i) {
    var r = game.rounds[q.id];
    var asked = !!(r && r.phase !== 'waiting');
    var status = asked ? '<span class="q-status">' + PHASE_LABEL[r.phase] + '</span>' : '';
    var lock = asked ? ' disabled title="出題済みの問題は形式や選択肢の数を変えられません（進行画面で「この問題をやり直す」と変更できます）"' : '';
    var h = '<div class="qcard' + (q.id === game.cur ? ' current' : '') + '" data-id="' + q.id + '">';
    var sv = isSurvey();
    h += '<div class="qhead"><span class="qno">' + qLabel(i + 1) + '</span>' + status +
      '<select data-f="type"' + lock + '>' +
      '<option value="text"' + (q.type === 'text' ? ' selected' : '') + '>記述（文字で回答）</option>' +
      '<option value="choice"' + (q.type === 'choice' ? ' selected' : '') + '>選択式</option>' +
      '<option value="draw"' + (q.type === 'draw' ? ' selected' : '') + '>手書き（フリップ）</option>' +
      '</select>' +
      (sv ? '' : '<label class="num">配点 <input type="number" data-f="pts" min="0" max="1000" value="' + q.pts + '"> 点</label>') +
      '<label class="num">制限時間 <input type="number" data-f="lim" min="0" max="600" value="' + q.lim + '"> 秒</label>' +
      '<span class="spacer"></span>' +
      '<button class="btn icon small" data-act="q-up" title="上へ"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button class="btn icon small" data-act="q-down" title="下へ"' + (i === questions.length - 1 ? ' disabled' : '') + '>↓</button>' +
      '<button class="btn small" data-act="q-dup">複製</button>' +
      '<button class="btn small danger" data-act="q-del">削除</button>' +
      '<button class="btn small" data-act="q-go">この問題へ</button>' +
      '</div>';
    h += '<textarea data-f="text" rows="2" maxlength="400" placeholder="問題文を入力">' + esc(q.text) + '</textarea>';
    if (q.type === 'text') {
      if (!sv) h += '<label class="qlabel">正解（別解は改行で区切る。空欄なら手動で判定）</label>' +
        '<textarea data-f="answer" rows="2" maxlength="400" placeholder="例：富士山&#10;ふじさん">' + esc(q.answer) + '</textarea>';
    } else if (q.type === 'choice') {
      h += '<label class="qlabel">' + (sv ? '選択肢' : '選択肢（正解にチェック。複数可・なしなら手動で判定）') + '</label><div class="qchoices">';
      q.choices.forEach(function (c, k) {
        h += '<div class="qchoice">' + (sv ? '' : '<label class="chk"><input type="checkbox" data-f="correct" data-i="' + k + '"' +
          (q.correct.indexOf(k) >= 0 ? ' checked' : '') + '> 正解</label>') +
          '<span class="cl c' + k + '">' + QP.choiceLabel(k) + '</span>' +
          '<input type="text" data-f="choice" data-i="' + k + '" maxlength="80" value="' + esc(c) + '" placeholder="選択肢' + QP.choiceLabel(k) + '">' +
          '<button class="btn icon small" data-act="q-delchoice" data-i="' + k + '"' + (q.choices.length <= 2 || asked ? ' disabled' : ' title="この選択肢を削除"') + '>×</button></div>';
      });
      h += '</div>';
      if (q.choices.length < 6 && !asked) h += '<button class="btn small" data-act="q-addchoice">＋ 選択肢を追加</button>';
    } else if (!sv) {
      h += '<label class="qlabel">模範解答（正解発表のときに表示。判定はパネルをクリックして手動で行います）</label>' +
        '<input type="text" data-f="answer" maxlength="100" value="' + esc(q.answer) + '" placeholder="空欄でもかまいません">';
    }
    h += '</div>';
    return h;
  }

  var qSaveTimer = null;
  function questionsChanged(structural) {
    fixCur();
    clearTimeout(qSaveTimer);
    qSaveTimer = setTimeout(function () {
      if (session) session.act = now();
      saveNow();
      publishNow();
      renderControl();
    }, structural ? 0 : 400);
    if (structural) renderQuestions();
  }

  function onQuestionInput(e) {
    var card = e.target.closest('.qcard');
    var f = e.target.dataset.f;
    if (!card || !f) return;
    var q = qById(card.dataset.id);
    if (!q) return;
    var structural = false;
    if (f === 'text') q.text = e.target.value.slice(0, 400);
    else if (f === 'answer') q.answer = e.target.value.slice(0, 400);
    else if (f === 'pts') q.pts = clampInt(e.target.value, 0, 1000, 0);
    else if (f === 'lim') q.lim = clampInt(e.target.value, 0, 600, 0);
    else if (f === 'choice') q.choices[+e.target.dataset.i] = e.target.value.slice(0, 80);
    else if (f === 'correct') {
      var k = +e.target.dataset.i;
      q.correct = q.correct.filter(function (x) { return x !== k; });
      if (e.target.checked) q.correct.push(k);
      q.correct.sort();
    } else if (f === 'type') {
      if (e.type !== 'change') return;
      q.type = e.target.value;
      if (q.type === 'choice' && q.choices.length < 2) {
        q.choices = ['', '', '', ''];
        q.correct = [];
      }
      structural = true;
    }
    questionsChanged(structural);
  }

  function onQuestionAction(act, btn) {
    var card = btn.closest('.qcard');
    var q = card ? qById(card.dataset.id) : null;
    var i = q ? qIndex(q.id) : -1;
    if (act === 'q-add') {
      var nq = fixQuestion({ type: 'text', text: '', answer: '', pts: 10, lim: 0 });
      questions.push(nq);
      questionsChanged(true);
      var cards = $$('.qcard');
      if (cards.length) {
        var ta = $('textarea[data-f="text"]', cards[cards.length - 1]);
        if (ta) { ta.focus(); ta.scrollIntoView({ block: 'center' }); }
      }
      return;
    }
    if (act === 'q-sample') {
      (isSurvey() ? sampleSurvey() : sampleQuestions()).forEach(function (s) { questions.push(s); });
      questionsChanged(true);
      return;
    }
    if (act === 'q-clear') {
      ask('すべての問題を削除しますか？（回答の記録も消えます）', 'すべて削除').then(function (ok) {
        if (!ok) return;
        questions = [];
        game.rounds = {};
        game.final = false;
        questionsChanged(true);
        renderAll();
      });
      return;
    }
    if (act === 'q-export') {
      var blob = new Blob([JSON.stringify({ app: 'quizpanel', v: 1, questions: questions }, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'quiz-questions.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return;
    }
    if (!q) return;
    if (act === 'q-up' && i > 0) { questions.splice(i - 1, 0, questions.splice(i, 1)[0]); questionsChanged(true); }
    else if (act === 'q-down' && i < questions.length - 1) { questions.splice(i + 1, 0, questions.splice(i, 1)[0]); questionsChanged(true); }
    else if (act === 'q-dup') {
      var copy = fixQuestion(JSON.parse(JSON.stringify(q)));
      copy.id = qid();
      questions.splice(i + 1, 0, copy);
      questionsChanged(true);
    } else if (act === 'q-del') {
      ask('第' + (i + 1) + '問を削除しますか？', '削除').then(function (ok) {
        if (!ok) return;
        questions.splice(i, 1);
        delete game.rounds[q.id];
        if (game.cur === q.id) game.cur = questions[Math.min(i, questions.length - 1)] ? questions[Math.min(i, questions.length - 1)].id : null;
        questionsChanged(true);
      });
    } else if (act === 'q-addchoice' && q.choices.length < 6) {
      q.choices.push('');
      questionsChanged(true);
    } else if (act === 'q-delchoice') {
      var k = +btn.dataset.i;
      if (q.choices.length <= 2) return;
      q.choices.splice(k, 1);
      q.correct = q.correct.filter(function (x) { return x !== k; }).map(function (x) { return x > k ? x - 1 : x; });
      questionsChanged(true);
    } else if (act === 'q-go') {
      setCur(q.id);
      tab = 'play';
      renderAll();
    }
  }

  function importQuestions(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data = QP.parse(String(reader.result));
      var list = data && Array.isArray(data.questions) ? data.questions : (Array.isArray(data) ? data : null);
      if (!list) { QP.toast('読み込めませんでした（形式が違います）'); return; }
      var fixed = list.map(fixQuestion).filter(Boolean);
      ask(fixed.length + '問を読み込みます。いまの問題に追加しますか？それとも置き換えますか？', '追加する', '置き換える').then(function (res) {
        if (res === null) return;
        if (res === false) { questions = []; game.rounds = {}; }
        fixed.forEach(function (q) {
          if (qById(q.id)) q.id = qid();
          questions.push(q);
        });
        questionsChanged(true);
        renderAll();
        QP.toast(fixed.length + '問を読み込みました');
      });
    };
    reader.readAsText(file);
  }

  // ---- 参加者 ----
  function renderPlayers() {
    var el = $('#tab-players');
    var ids = playerIds();
    var sc = scores();
    var rk = QP.ranks(ids, function (pid) { return sc[pid] || 0; });
    var q = curQ();
    var r = curRound();
    var html = '<div class="q-toolbar"><button class="btn" data-act="rollcall">点呼する（全員に名乗り直しを依頼）</button>' +
      '<button class="btn" data-act="show-join">参加用のQR・URL</button></div>';
    html += '<p class="muted small">●はサーバーごとのつながり具合です。すべてのサーバーとの接続が切れたときだけ「切断」と表示します。スマホがスリープすると、30〜45秒ほどで切断になります。</p>';
    if (!ids.length) {
      html += '<div class="q-empty">まだ誰も参加していません。参加コード <b>' + (session ? QP.formatCode(session.code) : '') + '</b> を伝えてください。</div>';
    } else {
      var sv = isSurvey();
      html += '<table class="ptable"><thead><tr><th>#</th><th>名前</th><th>接続</th>' + (sv ? '' : '<th>順位</th><th>得点</th>') + '<th>' + (sv ? 'この質問' : 'この問題') + '</th><th></th></tr></thead><tbody>';
      ids.forEach(function (pid, i) {
        var p = game.players[pid];
        var o = online[pid] || {};
        var dots = CFG.BROKERS.map(function (b, k) {
          return '<span class="lamp-dot ' + (o[k] ? 'connected' : 'off') + '" title="' + esc(b.name) + '"></span>';
        }).join('');
        var a = r && r.phase !== 'waiting' ? r.answers[pid] : null;
        html += '<tr' + (isOnline(pid) ? '' : ' class="off"') + '><td>' + (i + 1) + '</td><td class="nm">' + esc(p.name) + '</td>' +
          '<td><span class="net-lamps">' + dots + '</span> ' + (isOnline(pid) ? '<span class="ok">接続中</span>' : '<span class="ng">切断</span>') + '</td>' +
          (sv ? '' : '<td>' + rk.rank[pid] + '位</td><td>' + (sc[pid] || 0) + '点</td>') +
          '<td class="ans">' + (a ? esc(answerText(q, a)) : '<span class="muted">—</span>') + '</td>' +
          '<td><button class="btn small danger" data-act="kick" data-pid="' + pid + '">外す</button></td></tr>';
      });
      html += '</tbody></table>';
    }
    el.innerHTML = html;
  }

  function kick(pid) {
    var p = game.players[pid];
    if (!p) return;
    ask(p.name + ' さんを参加者から外しますか？', '外す').then(function (ok) {
      if (!ok) return;
      delete game.players[pid];
      delete online[pid];
      game.kicked[pid] = now();
      sendKick(pid);
      commit();
    });
  }

  function setMode(mode) {
    prefs.mode = mode === 'survey' ? 'survey' : 'quiz';
    if (isSurvey()) {
      game.final = false;
      stageView = 'board';
    }
    QP.toast(isSurvey() ? 'アンケートモードにしました' : 'クイズモードにしました');
    commit();
  }

  // ---- 設定 ----
  function renderSettings() {
    var el = $('#tab-settings');
    var html = '<div class="set-grid">';
    html += '<div class="set-card"><h3>モード</h3>' +
      '<label class="chk mode-opt"><input type="radio" name="prefMode" value="quiz"' + (isSurvey() ? '' : ' checked') + '> <b>クイズ</b>：正解発表・○×・得点・順位あり</label>' +
      '<label class="chk mode-opt"><input type="radio" name="prefMode" value="survey"' + (isSurvey() ? ' checked' : '') + '> <b>アンケート</b>：回答を表示するだけ（正解・得点なし）</label>' +
      '<p class="muted small">途中で切り替えてもかまいません。回答者の画面もすぐに切り替わります。</p></div>';

    html += '<div class="set-card"><h3>参加コード</h3><div class="set-code">' + (session && !sessionBusy ? QP.formatCode(session.code) : '準備中…') + '</div>' +
      '<p class="muted small">コードを変えると、いまの参加者はいったん参加画面に戻ります（得点もリセットされます）。操作のない状態が' + CFG.SESSION_TTL_HOURS + '時間続くと自動で新しいコードになります。</p>' +
      '<button class="btn" data-act="newcode"' + (sessionBusy ? ' disabled' : '') + '>新しいコードに変更</button></div>';

    html += '<div class="set-card"><h3>回答者ページのURL</h3><p class="muted small">QRコードと参加URLに使います。空欄なら自動で決めます（いまは ' + esc(playerBaseUrl()) + '）。</p>' +
      '<input type="url" id="playerUrl" placeholder="https://（ユーザー名）.github.io/' + esc(CFG.PLAYER_REPO) + '/" value="' + esc(prefs.playerUrl || '') + '">' +
      '<div class="row"><button class="btn" data-act="save-url">保存</button><button class="btn" data-act="show-join">QR・URLを表示</button></div></div>';

    html += '<div class="set-card"><h3>得点と回答</h3><p class="muted small">参加者はそのままで、すべての問題の回答・判定・得点を消します。</p>' +
      '<button class="btn danger" data-act="reset-scores">得点と回答をリセット</button></div>';

    html += '<div class="set-card"><h3>効果音</h3><label class="chk"><input type="checkbox" id="prefSound"' + (prefs.sound ? ' checked' : '') + '> 効果音を鳴らす</label></div>';

    html += '<div class="set-card wide"><h3>サーバーとの接続</h3><table class="ptable"><thead><tr><th>サーバー</th><th>状態</th><th>詳細</th></tr></thead><tbody>' +
      netStatus.map(function (s) {
        var b = CFG.BROKERS[s.idx] || {};
        return '<tr><td><span class="lamp-dot ' + s.state + '"></span> ' + esc(s.name) + '<div class="muted small">' + esc(b.url || '') + '</div></td><td>' + stateLabel(s.state) + '</td><td class="muted small">' + esc(s.error || '') + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="muted small">' + CFG.BROKERS.length + 'つのサーバーに同時に接続しています。回答者と共通でつながるサーバーが1つでもあれば動きます。トピック: ' + esc(CFG.APP_NS) + '/' + (session ? session.code : '…') + '/…</p></div>';
    html += '</div>';
    el.innerHTML = html;
  }

  // ---- モーダル ----
  var modalResolve = null;
  function openModal(html, cls) {
    var m = $('#modal');
    m.className = cls || '';
    m.innerHTML = '<div class="modal-box">' + html + '</div>';
    m.hidden = false;
  }
  function closeModal(result) {
    var m = $('#modal');
    m.hidden = true;
    m.innerHTML = '';
    if (modalResolve) {
      var r = modalResolve;
      modalResolve = null;
      r(result);
    }
  }
  // ok → true, alt → false, キャンセル → null（alt が無いときは false）
  function ask(msg, okLabel, altLabel) {
    if (modalResolve) closeModal(null);
    openModal('<div class="ask-msg">' + esc(msg) + '</div><div class="modal-actions">' +
      '<button class="btn ghost" data-act="modal-cancel">キャンセル</button>' +
      (altLabel ? '<button class="btn" data-act="modal-alt">' + esc(altLabel) + '</button>' : '') +
      '<button class="btn primary" data-act="modal-ok">' + esc(okLabel || 'OK') + '</button></div>');
    return new Promise(function (resolve) {
      modalResolve = function (v) {
        if (v === undefined) v = null;
        if (!altLabel && v === null) v = false;
        resolve(v);
      };
    });
  }

  function fatal(msg) {
    var f = $('#fatal');
    f.innerHTML = '<div class="fatal-box">' + msg + '</div>';
    f.hidden = false;
  }

  // ------------------------------------------------------------------
  // イベント
  // ------------------------------------------------------------------
  // 進行のキー操作（表示用ページで押したキーもここに届く）
  function handleKey(k) {
    if (!$('#modal').hidden) return false;
    if (k === ' ' || k === 'Enter') primaryAction();
    else if (k === 'a' || k === 'A') openAll();
    else if (k === 'j' || k === 'J') announce();
    else if (k === 'ArrowRight') moveQ(1);
    else if (k === 'ArrowLeft') moveQ(-1);
    else if (k === 'r' || k === 'R') toggleRank();
    else return false;
    return true;
  }

  function bindEvents() {
    document.addEventListener('click', function (e) {
      var tb = e.target.closest('.tabs button');
      if (tb) {
        tab = tb.dataset.tab;
        renderTabs();
        renderAll();
        return;
      }
      var btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      var act = btn.dataset.act;
      if (act.indexOf('q-') === 0) return onQuestionAction(act, btn);
      switch (act) {
        case 'primary': primaryAction(); break;
        case 'prev': moveQ(-1); break;
        case 'next': moveQ(1); break;
        case 'open-all': openAll(); break;
        case 'announce': announce(); break;
        case 'redo': redoRound(); break;
        case 'final':
          ask('最終結果を発表しますか？（回答者の画面にも順位が表示されます）', '発表する').then(function (ok) { if (ok) showFinal(); });
          break;
        case 'hide-final': hideFinal(); break;
        case 'toggle-rank': toggleRank(); break;
        case 'toggle-answer': showAnswer = !showAnswer; renderControl(); break;
        case 'present': setPresenting(true); break;
        case 'open-board': openBoardWindow(); break;
        case 'present-off': setPresenting(false); break;
        case 'sound': prefs.sound = !prefs.sound; saveSoon(); renderControl(); break;
        case 'goto-questions': tab = 'questions'; renderAll(); break;
        case 'show-join': showJoinModal(); break;
        case 'copy-url': QP.copyText(joinUrl()).then(function () { QP.toast('URLをコピーしました'); }); break;
        case 'close-modal': closeModal(); break;
        case 'modal-ok': closeModal(true); break;
        case 'modal-alt': closeModal(false); break;
        case 'modal-cancel': closeModal(null); break;
        case 'rollcall': rollcall(); break;
        case 'kick': kick(btn.dataset.pid); break;
        case 'newcode':
          ask('新しい参加コードに変更しますか？いまの参加者は参加画面に戻り、得点もリセットされます。', '変更する').then(function (ok) {
            if (ok) newSession();
          });
          break;
        case 'save-url':
          var v = $('#playerUrl').value.trim();
          if (v && !/^https?:\/\//.test(v)) { QP.toast('http:// か https:// で始まるURLを入力してください'); break; }
          if (v && !/\/$/.test(v) && v.indexOf('?') < 0 && !/\.html$/.test(v)) v += '/';
          prefs.playerUrl = v;
          saveNow();
          renderSettings();
          QP.toast('保存しました');
          break;
        case 'reset-scores':
          ask('すべての問題の回答・判定・得点を消しますか？', 'リセット').then(function (ok) {
            if (!ok) return;
            game.rounds = {};
            game.final = false;
            stageView = 'board';
            commit();
          });
          break;
      }
    });

    document.addEventListener('change', function (e) {
      if (e.target.id === 'qSelect') {
        var id = e.target.value;
        var r = curRound();
        if (r && r.phase === 'open') {
          ask('回答を受け付けています。締め切って移動しますか？', '締め切って移動').then(function (ok) {
            if (ok) setCur(id); else renderControl();
          });
        } else {
          setCur(id);
        }
        return;
      }
      if (e.target.id === 'qImport' && e.target.files[0]) {
        importQuestions(e.target.files[0]);
        e.target.value = '';
        return;
      }
      if (e.target.name === 'prefMode') {
        setMode(e.target.value);
        return;
      }
      if (e.target.id === 'prefSound') {
        prefs.sound = e.target.checked;
        saveNow();
        return;
      }
      if (e.target.closest('#tab-questions')) onQuestionInput(e);
    });

    document.addEventListener('input', function (e) {
      if (e.target.closest('#tab-questions') && e.target.dataset.f !== 'type' && e.target.dataset.f !== 'correct') onQuestionInput(e);
    });

    $('#modal').addEventListener('click', function (e) {
      if (e.target.id === 'modal') closeModal(null);
    });

    document.addEventListener('keydown', function (e) {
      if (!$('#modal').hidden) {
        if (e.key === 'Escape') closeModal(null);
        return;
      }
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (tab !== 'play' || e.ctrlKey || e.metaKey || e.altKey) return;
      var k = e.key;
      if (k === 'f' || k === 'F') setPresenting(!presenting);
      else if (k === 'Escape' && presenting) setPresenting(false);
      else if (handleKey(k)) e.preventDefault();
    });

    document.addEventListener('fullscreenchange', function () {
      if (!document.fullscreenElement && presenting) setPresenting(false);
    });
    document.addEventListener('mousemove', pokeIdle);

    var rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { if (stage) stage.relayout(); }, 120);
    });

    $('#btnQr').addEventListener('click', showJoinModal);
  }

  // ------------------------------------------------------------------
  // 複数タブで同時にホスト画面を開いたときの対策
  // ------------------------------------------------------------------
  var channel = null;
  var tabId = NET.randomId(8);
  function tabGuard() {
    return new Promise(function (resolve) {
      if (!('BroadcastChannel' in window)) return resolve();
      channel = new BroadcastChannel('quizpanel-host');
      var other = false;
      channel.onmessage = function (e) {
        var m = e.data || {};
        if (m.t === 'ping' && active) channel.postMessage({ t: 'pong', id: tabId });
        if (m.t === 'pong') other = true;
        if (m.t === 'takeover' && m.id !== tabId && active) deactivate();
      };
      channel.postMessage({ t: 'ping', id: tabId });
      setTimeout(function () {
        if (!other) return resolve();
        fatal('<p>このホスト画面は別のタブ（またはウィンドウ）でも開かれています。</p>' +
          '<p>同時に動かすと進行が混ざるため、どちらか一方だけを使ってください。</p>' +
          '<button class="btn primary" id="takeover">このタブで続ける</button>');
        $('#takeover').addEventListener('click', function () {
          channel.postMessage({ t: 'takeover', id: tabId });
          $('#fatal').hidden = true;
          setTimeout(resolve, 600);
        });
      }, 400);
    });
  }
  function deactivate() {
    saveNow();
    active = false;
    if (net) net.stop();
    if (boardCh) { try { boardCh.close(); } catch (e) { /* ignore */ } boardCh = null; }
    fatal('<p>別のタブでホスト画面が使われ始めたため、このタブは停止しました。</p>' +
      '<button class="btn primary" onclick="location.reload()">このタブで再開する</button>');
  }

  // ------------------------------------------------------------------
  // 起動
  // ------------------------------------------------------------------
  function boot() {
    bindEvents();
    QP.loadMqtt().then(function () {
      return tabGuard();
    }).then(function () {
      active = true;
      loadAll();
      stage = new QP.Stage($('#stage'), { onPanelClick: handlePanelClick });
      setupBoardChannel();
      if (session && now() - (session.act || session.created || 0) > QP.TTL_MS) {
        // 時間切れのセッション。古いコードの保持データは新しいコードを決めるときに消す
        game = newGame();
        fixCur();
      }
      renderAll();
      net = new NET.MultiBroker({
        brokers: CFG.BROKERS,
        subscriptions: session ? subsFor(session.code) : [],
        onMessage: onMessage,
        onConnect: onConnect,
        onDown: onDown,
        onStatus: onStatus
      });
      net.start();
      if (!session || now() - (session.act || session.created || 0) > QP.TTL_MS) newSession();
      setInterval(tick, 200);
      setInterval(publishNow, CFG.STATE_RESEND_MS);
      setInterval(checkExpiry, 60 * 1000);
      setInterval(function () { renderSoon('header'); }, 5000);
      window.addEventListener('pagehide', saveNow);
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () { if (stage) stage.relayout(); });
      }
      pokeIdle();
    }).catch(function (err) {
      console.error(err);
      fatal('<p><b>ライブラリの読み込みに失敗しました。</b></p><p>広告ブロッカーやコンテンツブロッカーを止めるか、別のブラウザ・別の回線でお試しください。</p>' +
        '<button class="btn primary" onclick="location.reload()">再読み込み</button>');
    });
  }

  // テスト用に一部を公開
  window.QP_HOST = {
    get state() { return { questions: questions, session: session, game: game, online: online }; },
    buildState: function () { return buildState(); },
    buildView: function () { return buildView(); }
  };

  boot();
})();
