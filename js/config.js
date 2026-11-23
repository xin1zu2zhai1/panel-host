/*
 * クイズパネル 共通設定（ホスト側・回答者側で同じ内容にすること）
 *
 * 通信仕様:
 *  - 公開 MQTT サーバー 5 つに「同時に」WebSocket(wss) で接続する。
 *  - 送信はつながっている全サーバーへ、受信はどのサーバーからでも受け取る。
 *  - トピックは {APP_NS}/{6桁の参加コード}/{種類}
 */
(function (global) {
  'use strict';

  var CONFIG = {
    // トピックの先頭。他のアプリとぶつからないよう固有の文字列にしている。
    // ホスト側と回答者側で必ず同じ値にすること。
    APP_NS: 'quizpanel-x1z2-v1',

    // 接続先サーバー（5つすべてに同時接続）
    BROKERS: [
      { name: 'eclipseprojects', url: 'wss://mqtt.eclipseprojects.io:443/mqtt' },
      { name: 'shiftr', url: 'wss://public.cloud.shiftr.io:443', username: 'public', password: 'public' },
      { name: 'emqx', url: 'wss://broker.emqx.io:8084/mqtt' },
      { name: 'hivemq', url: 'wss://broker.hivemq.com:8884/mqtt' },
      { name: 'mosquitto', url: 'wss://test.mosquitto.org:8081' }
    ],

    // MQTT 接続の設定
    KEEPALIVE_SEC: 30,
    RECONNECT_MS: 4000,
    CONNECT_TIMEOUT_MS: 10000,

    // 操作のない状態がこの時間続いたセッションは無効
    SESSION_TTL_HOURS: 6,

    // ホストが state を送り直す間隔（ゲームが続いていることを示す）
    STATE_RESEND_MS: 10 * 60 * 1000,

    // 新しい参加コードを決める前に、使用中か確かめる待ち時間と回数
    CODE_CHECK_WAIT_MS: 1500,
    CODE_CHECK_MAX_TRY: 5,
    RECENT_CODES_MAX: 200,

    // 回答者ページの URL（空なら自動で決める）
    // GitHub Pages では https://<ユーザー名>.github.io/Answer/ になる（大文字・小文字もリポジトリ名どおりに）。
    PLAYER_URL: '',
    PLAYER_REPO: 'Answer',

    // 回答の上限
    MAX_TEXT_LEN: 60,
    MAX_NAME_LEN: 12,
    MAX_DRAW_POINTS: 4000,
    DRAW_W: 500,
    DRAW_H: 300
  };

  // テスト用: ページ読み込み前に window.__QP_BROKERS__ を定義すると接続先を差し替えられる
  if (global.__QP_BROKERS__ && global.__QP_BROKERS__.length) {
    CONFIG.BROKERS = global.__QP_BROKERS__;
  }

  global.QP_CONFIG = CONFIG;
})(window);
