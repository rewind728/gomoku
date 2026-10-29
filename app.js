/**
 * 五子棋 · 双人联机
 *
 * 架构：两端浏览器通过公共 MQTT 中转站交换 JSON 消息，
 * 没有任何后端。双方各自在本地跑同一套确定性规则，
 * 用序号去重、用整盘快照做断线恢复。
 */

import mqtt from './vendor/mqtt.esm.js';
import {
  SIZE, EMPTY, BLACK, WHITE,
  createBoard, idx, findWin, inBounds, isBoardFull,
} from './rules.js';

/* ══════════════ 配置 ══════════════ */

const BROKER = 'wss://broker.emqx.io:8084/mqtt';
const TOPIC_PREFIX = 'gomoku/v1/';
const PROTO = 1;
const PING_MS = 5000;
const PEER_TIMEOUT_MS = 14000;
const REQUEST_TIMEOUT_MS = 20000;
const STORAGE_KEY = 'gomoku.session.v1';

const QUICK_PHRASES = [
  '好棋！', '手下留情', '快点啦', '这步厉害',
  '我认输了', '再来一局', '谢谢指教', '👍', '😅', '🤔',
];

/* ══════════════ 工具 ══════════════ */

const $ = (sel, root = document) => root.querySelector(sel);

const randId = (n = 12) => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
};

const opponentOf = (c) => (c === BLACK ? WHITE : BLACK);
const fmtClock = (sec) => (sec >= 10 ? String(Math.ceil(sec)) : String(Math.max(0, Math.ceil(sec))));
const safe = (fn) => { try { fn(); } catch (e) { console.error(e); } };

/* ══════════════ DOM ══════════════ */

const el = {
  screens: {
    home: $('#screen-home'),
    lobby: $('#screen-lobby'),
    game: $('#screen-game'),
  },
  timeOptions: $('#time-options'),
  timeoutLose: $('#timeout-lose'),
  btnCreate: $('#btn-create'),
  btnResume: $('#btn-resume'),
  shareLink: $('#share-link'),
  btnCopy: $('#btn-copy'),
  lobbyStatus: $('#lobby-status'),
  roomChip: $('#room-chip'),
  ruleChip: $('#rule-chip'),
  btnLeaveLobby: $('#btn-leave-lobby'),
  canvas: $('#board'),
  cardTop: $('#card-top'),
  cardBottom: $('#card-bottom'),
  turnBanner: $('#turn-banner'),
  quickChat: $('#quick-chat'),
  quickRow: $('#quick-row'),
  btnUndo: $('#btn-undo'),
  btnDraw: $('#btn-draw'),
  btnResign: $('#btn-resign'),
  btnChat: $('#btn-chat'),
  overlay: $('#overlay'),
  dialogTitle: $('#dialog-title'),
  dialogText: $('#dialog-text'),
  dialogActions: $('#dialog-actions'),
  toastWrap: $('#toast-wrap'),
  bubbles: $('#bubbles'),
};

/* ══════════════ 状态 ══════════════ */

const S = {
  session: null,        // { roomId, role: 'host'|'guest', playerId }
  game: null,
  net: null,
  conn: 'idle',         // idle | connecting | online | offline
  peerId: null,
  guestId: null,
  peerSeen: 0,
  mySeq: 0,
  lastSeq: Object.create(null),
  pending: null,        // { kind, timer }
  resultKey: null,
  settings: { time: 30, timeoutLose: true },
  hover: null,
  clockTick: 0,
};

/* ══════════════ 房间与对局模型 ══════════════ */

const colorOf = (role, round) => {
  const hostIsBlack = round % 2 === 0;
  return role === 'host' ? (hostIsBlack ? BLACK : WHITE) : (hostIsBlack ? WHITE : BLACK);
};

function newGame(settings, round = 0) {
  return {
    board: createBoard(),
    moves: [],          // [x0, y0, x1, y1, ...]
    turn: BLACK,
    status: 'playing',  // playing | ended
    winner: 0,          // 0 和棋，BLACK/WHITE
    winLine: null,
    reason: '',         // five | full | resign | timeout | draw
    round,
    rev: 0,             // 每发生一次状态变更 +1，用于判定快照新旧
    settings: { ...settings },
    deadline: 0,
  };
}

const myColor = () => (S.game ? colorOf(S.session.role, S.game.round) : BLACK);
const oppColor = () => opponentOf(myColor());

/* ══════════════ 屏幕切换 ══════════════ */

let currentScreen = 'home';

function showScreen(name) {
  if (currentScreen === name) return;
  currentScreen = name;
  for (const [key, node] of Object.entries(el.screens)) {
    node.classList.toggle('hidden', key !== name);
  }
  if (name === 'game') requestAnimationFrame(layoutBoard);
}

/* ══════════════ Toast / Dialog ══════════════ */

function toast(text, ms = 2000) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = text;
  el.toastWrap.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 320);
  }, ms);
}

let dialogOpen = false;

function dialog({ title, text = '', actions = [], dismissible = false }) {
  el.dialogTitle.textContent = title;
  el.dialogText.textContent = text;
  el.dialogText.classList.toggle('hidden', !text);
  el.dialogActions.replaceChildren();

  actions.forEach((action) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${action.kind || 'primary'}`;
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      if (action.keepOpen !== true) closeDialog();
      action.onClick?.();
    });
    el.dialogActions.appendChild(btn);
  });

  el.overlay.classList.remove('hidden');
  el.overlay.dataset.dismissible = dismissible ? '1' : '0';
  dialogOpen = true;
}

function closeDialog() {
  el.overlay.classList.add('hidden');
  dialogOpen = false;
}

el.overlay.addEventListener('click', (e) => {
  if (e.target === el.overlay && el.overlay.dataset.dismissible === '1') closeDialog();
});

/* ══════════════ 连接状态 ══════════════ */

function setConn(state) {
  S.conn = state;
  if (currentScreen === 'lobby') {
    const map = {
      connecting: '正在连接服务器…',
      online: S.peerId ? '对手已进入，准备开始' : '等待对手加入…',
      offline: '连接断开，正在重连…',
      idle: '未连接',
    };
    el.lobbyStatus.textContent = map[state] || '';
  }
  draw();
}

function peerOnline() {
  return S.peerId !== null && Date.now() - S.peerSeen < PEER_TIMEOUT_MS;
}

/* ══════════════ 网络层 ══════════════ */

function send(msg) {
  if (!S.net || !S.net.connected) { trace('✗', msg.t); return false; }
  const payload = { ...msg, from: S.session.playerId, seq: ++S.mySeq };
  S.net.publish(TOPIC_PREFIX + S.session.roomId, JSON.stringify(payload), { qos: 1 });
  trace('→', msg.t);
  return true;
}

/* 最近若干条收发记录，只在调试时用 */
const traceLog = [];
function trace(dir, t) {
  traceLog.push(`${dir}${t}`);
  if (traceLog.length > 80) traceLog.shift();
}

function connect() {
  disconnect();

  S.conn = 'connecting';
  setConn('connecting');

  const client = mqtt.connect(BROKER, {
    clientId: 'gmk_' + S.session.playerId,
    clean: true,
    keepalive: 25,
    reconnectPeriod: 2500,
    connectTimeout: 15000,
    protocolVersion: 4,
  });

  S.net = client;

  client.on('connect', () => {
    setConn('online');
    // 必须等 SUBACK 之后再打招呼：否则对方回过来的棋局快照会被丢掉
    client.subscribe(TOPIC_PREFIX + S.session.roomId, { qos: 1 }, (err) => {
      if (err) { setConn('offline'); return; }
      send({ t: 'hello', proto: PROTO, role: S.session.role });
      if (S.game) setTimeout(sendState, 500);
    });
  });

  client.on('reconnect', () => setConn('connecting'));
  client.on('offline', () => setConn('offline'));
  client.on('error', (err) => {
    console.warn('[mqtt]', err?.message);
    setConn('offline');
  });

  client.on('message', (_topic, payload) => {
    let msg;
    try { msg = JSON.parse(payload.toString()); } catch { return; }
    handleMessage(msg);
  });
}

function disconnect() {
  if (S.net) {
    safe(() => S.net.end(true));
    S.net = null;
  }
}

/* ══════════════ 消息处理 ══════════════ */

function handleMessage(msg) {
  if (!msg || !S.session || msg.from === S.session.playerId) return;
  trace('←', msg.t);

  if (msg.t === 'hello') { onHello(msg); return; }
  if (msg.t === 'full') { onRoomFull(); return; }

  // 晚加入的一方可能错过了对方的 hello。
  // 整盘快照是幂等的，允许它反过来确立对手身份。
  if (msg.from !== S.peerId) {
    if (msg.t === 'state' && !S.peerId) {
      S.peerId = msg.from;
      S.peerSeen = Date.now();
      S.lastSeq[msg.from] = -1;
    } else {
      return;   // 陌生客户端的其它消息一律忽略
    }
  }

  const seen = S.lastSeq[msg.from] ?? -1;
  if (typeof msg.seq === 'number') {
    if (msg.seq <= seen) return;
    S.lastSeq[msg.from] = msg.seq;
  }

  S.peerSeen = Date.now();

  switch (msg.t) {
    case 'state':     onRemoteState(msg); break;
    case 'move':      onRemoteMove(msg); break;
    case 'undo-req':  onUndoRequest(msg); break;
    case 'undo-ack':  onAck(msg, 'undo'); break;
    case 'draw-req':  onDrawRequest(msg); break;
    case 'draw-ack':  onAck(msg, 'draw'); break;
    case 'restart-req': onRestartRequest(msg); break;
    case 'restart-ack': onAck(msg, 'restart'); break;
    case 'resign':    onRemoteResign(msg); break;
    case 'timeout':   onRemoteTimeout(msg); break;
    case 'chat':      bubble(msg.text, false); break;
    case 'ping':      break;
    default: break;
  }
}

function onHello(msg) {
  if (msg.proto !== PROTO) return;
  if (msg.role === S.session.role) return;   // 同角色：可能是自己另一个标签页

  // 房主负责登记来客，并挡住第三个人
  if (S.session.role === 'host') {
    if (S.guestId && S.guestId !== msg.from) {
      send({ t: 'full' });
      return;
    }
    S.guestId = msg.from;
  }

  S.lastSeq[msg.from] = -1;                  // 对方重连，序号从头计
  S.peerId = msg.from;
  S.peerSeen = Date.now();

  if (currentScreen === 'lobby') {
    el.lobbyStatus.textContent = '对手已进入，准备开始';
  }

  if (S.game) {
    sendState();                             // 已有棋局：把整盘推过去
  } else if (S.session.role === 'host') {
    startRound(0);                           // 房主开局
  }

  setConn(S.conn);
}

function onRoomFull() {
  disconnect();
  showScreen('home');
  clearSession();
  dialog({
    title: '房间已满',
    text: '这个房间已经有两个人了。让朋友创建一个新房间再发给你吧。',
    actions: [{ label: '好的', kind: 'ghost', onClick: () => {} }],
  });
}

/* ══════════════ 整盘同步 ══════════════ */

function serializeState() {
  const g = S.game;
  const remaining = g.deadline && g.status === 'playing'
    ? Math.max(0, g.deadline - Date.now())
    : 0;

  return {
    t: 'state',
    board: Array.from(g.board).join(''),
    moves: g.moves.slice(),
    turn: g.turn,
    status: g.status,
    winner: g.winner,
    winLine: g.winLine,
    reason: g.reason,
    round: g.round,
    rev: g.rev,
    settings: g.settings,
    remaining,
  };
}

function sendState() {
  if (!S.game) return;
  send(serializeState());
}

function onRemoteState(msg) {
  if (!msg.board || msg.board.length !== SIZE * SIZE) return;

  // 快照只在新于本地时生效。
  // 比较依据是 (局数, 版本号)：版本号每次落子/悔棋都会 +1，
  // 这样就既不会被过期快照冲掉，也能自动补齐丢失的消息。
  const cur = S.game;
  if (cur) {
    const mRound = msg.round ?? 0;
    const mRev = msg.rev ?? 0;

    if (mRound < cur.round) return;
    if (mRound === cur.round) {
      if (mRev < cur.rev) return;
      if (mRev === cur.rev) {
        const same = Array.from(cur.board).join('') === msg.board;
        if (same) return;                              // 完全一致，不必重画
        if (S.session.role === 'host') return;         // 同版本冲突时以房主为准
      }
    }
  }

  const game = newGame(msg.settings || S.settings, msg.round || 0);
  for (let i = 0; i < game.board.length; i++) game.board[i] = Number(msg.board[i]) || EMPTY;
  game.moves = Array.isArray(msg.moves) ? msg.moves.slice() : [];
  game.turn = msg.turn || BLACK;
  game.status = msg.status || 'playing';
  game.winner = msg.winner || 0;
  game.winLine = msg.winLine || null;
  game.reason = msg.reason || '';
  game.rev = msg.rev || 0;
  game.deadline = game.status === 'playing' && msg.remaining > 0
    ? Date.now() + msg.remaining
    : 0;

  S.game = game;
  S.settings = { ...game.settings };

  if (currentScreen !== 'game') {
    showScreen('game');
    layoutBoard();
  }
  closeDialog();
  draw();
  renderHud();

  if (game.status === 'ended' && !dialogOpen) showResult();
}

/* ══════════════ 回合控制 ══════════════ */

function startRound(round, broadcast = true) {
  S.game = newGame(S.settings, round);
  S.game.deadline = S.game.settings.time ? Date.now() + S.game.settings.time * 1000 : 0;
  S.resultKey = null;

  // 只有「对手刚进来、本地已有棋局」这种不确定对方状态时才广播快照。
  // 重开一局是双方确定性的本地操作，广播反而可能冲掉对方刚落下的子。
  if (broadcast && S.session.role === 'host') send(serializeState());

  closeDialog();
  showScreen('game');
  try { layoutBoard(); } catch (err) { console.error('[layout]', err); }
  draw();
  renderHud();
}

/* ══════════════ 落子 ══════════════ */

function applyMove(x, y, color) {
  const g = S.game;
  if (!g || g.status !== 'playing') return false;
  if (color !== g.turn) return false;
  if (!inBounds(x, y) || g.board[idx(x, y)] !== EMPTY) return false;

  g.board[idx(x, y)] = color;
  g.moves.push(x, y);

  const win = findWin(g.board, x, y, color);
  if (win) {
    g.status = 'ended';
    g.winner = color;
    g.winLine = win;
    g.reason = 'five';
    g.deadline = 0;
  } else if (isBoardFull(g.board)) {
    g.status = 'ended';
    g.winner = 0;
    g.reason = 'full';
    g.deadline = 0;
  } else {
    g.turn = opponentOf(color);
    g.deadline = g.settings.time ? Date.now() + g.settings.time * 1000 : 0;
  }

  g.rev++;
  return true;
}

function onRemoteMove(msg) {
  if (!S.game) return;
  if (applyMove(msg.x, msg.y, msg.color)) {
    draw();
    renderHud();
    if (S.game.status === 'ended') showResult();
  }
}

function tryPlay(x, y) {
  const g = S.game;
  if (!g || g.status !== 'playing') return false;
  if (!peerOnline()) { toast('对手还没连上'); return false; }
  if (g.turn !== myColor()) { toast('还没轮到你'); return false; }
  if (!inBounds(x, y) || g.board[idx(x, y)] !== EMPTY) return false;

  const color = myColor();
  if (!applyMove(x, y, color)) return false;

  send({ t: 'move', x, y, color });
  if (navigator.vibrate) safe(() => navigator.vibrate(8));

  draw();
  renderHud();
  if (g.status === 'ended') showResult();
  return true;
}

/* ══════════════ 计时 ══════════════ */

setInterval(() => {
  const g = S.game;
  if (!g || currentScreen !== 'game') return;

  if (g.status === 'playing' && g.deadline) {
    const remain = g.deadline - Date.now();
    if (remain <= 0) {
      if (g.settings.timeoutLose) {
        g.deadline = 0;
        const loser = g.turn;
        g.status = 'ended';
        g.winner = opponentOf(loser);
        g.reason = 'timeout';
        send({ t: 'timeout', winner: g.winner });
        draw();
        renderHud();
        showResult();
        return;
      }
    }
  }
  updateClocks();
}, 200);

function updateClocks() {
  const g = S.game;
  if (!g) return;

  for (const [card, color] of [[el.cardTop, oppColor()], [el.cardBottom, myColor()]]) {
    const clock = $('[data-clock]', card);
    if (!clock) continue;

    if (g.settings.time === 0) {
      clock.textContent = '∞';
      clock.classList.remove('urgent');
      continue;
    }
    if (g.status !== 'playing' || g.turn !== color) {
      clock.textContent = '—';
      clock.classList.remove('urgent');
      continue;
    }

    const remain = Math.max(0, (g.deadline - Date.now()) / 1000);
    clock.textContent = fmtClock(remain);
    clock.classList.toggle('urgent', remain <= 5);
  }
}

/* ══════════════ HUD ══════════════ */

function renderHud() {
  const g = S.game;
  if (!g) return;

  const mc = myColor();
  const oc = oppColor();

  $('.stone-icon', el.cardTop).dataset.color = oc === BLACK ? 'black' : 'white';
  $('.stone-icon', el.cardBottom).dataset.color = mc === BLACK ? 'black' : 'white';

  const online = peerOnline();
  const active = g.status === 'playing';

  el.cardTop.classList.toggle('active', active && g.turn === oc);
  el.cardBottom.classList.toggle('active', active && g.turn === mc);

  const tagTop = $('[data-tag]', el.cardTop);
  const tagBottom = $('[data-tag]', el.cardBottom);

  tagTop.textContent = !online ? '掉线中' : active && g.turn === oc ? '落子中' : '';
  tagTop.classList.toggle('warn', !online);

  tagBottom.textContent = active && g.turn === mc ? '轮到你' : '';
  tagBottom.classList.toggle('warn', false);

  // 操作按钮可用性
  const myTurn = active && g.turn === mc && online;
  el.btnUndo.disabled = !(active && online && g.moves.length > 0);
  el.btnDraw.disabled = !(active && online);
  el.btnResign.disabled = !active;
  el.btnChat.disabled = false;

  // 提示条
  if (active) {
    el.turnBanner.textContent = myTurn ? '轮到你落子' : '等待对手落子';
    el.turnBanner.classList.add('show');
    clearTimeout(el.turnBanner._t);
    el.turnBanner._t = setTimeout(() => el.turnBanner.classList.remove('show'), 1800);
  } else {
    el.turnBanner.classList.remove('show');
  }

  updateClocks();

  const caption = $('#board-caption');
  if (caption) {
    const n = g.moves.length / 2;
    caption.textContent = `第 ${g.round + 1} 局 · ` +
      (g.status === 'playing' ? `已下 ${n} 手` : `${n} 手结束`);
  }
}

/* ══════════════ 悔棋 / 和棋 / 认输 / 重开 ══════════════ */

function setPending(kind, data = {}) {
  clearPending(false);
  S.pending = {
    kind,
    data,
    timer: setTimeout(() => {
      S.pending = null;
      toast('对方没有回应');
    }, REQUEST_TIMEOUT_MS),
  };
}

function clearPending(notify = true) {
  if (S.pending) {
    clearTimeout(S.pending.timer);
    S.pending = null;
    if (notify) toast('请求已取消');
  }
}

/**
 * 悔棋：一直撤到请求方自己最近的那一手为止。
 * 若最后一手是对手的，会连撤两手，回到请求方的回合。
 */
function undoFor(color) {
  const g = S.game;
  if (!g || g.moves.length < 2) return false;

  while (g.moves.length >= 2) {
    const y = g.moves.pop();
    const x = g.moves.pop();
    const c = g.board[idx(x, y)];
    g.board[idx(x, y)] = EMPTY;
    if (c === color) break;
  }

  g.status = 'playing';
  g.winner = 0;
  g.winLine = null;
  g.reason = '';
  g.turn = color;
  g.deadline = g.settings.time ? Date.now() + g.settings.time * 1000 : 0;
  g.rev++;
  return true;
}

function requestUndo() {
  if (el.btnUndo.disabled) return;
  const color = myColor();
  send({ t: 'undo-req', color });
  setPending('undo', { color });
  toast('已发出悔棋请求');
  el.btnUndo.disabled = true;
}

function onUndoRequest(msg) {
  if (S.game?.status !== 'playing') return;
  dialog({
    title: '对方想悔棋',
    text: '同意的话，退回到对方上一手之前。',
    actions: [
      { label: '同意', kind: 'primary', onClick: () => {
        send({ t: 'undo-ack', ok: true });
        undoFor(msg.color);
        draw(); renderHud();
      } },
      { label: '拒绝', kind: 'ghost', onClick: () => send({ t: 'undo-ack', ok: false }) },
    ],
  });
}

function requestDraw() {
  send({ t: 'draw-req' });
  setPending('draw');
  toast('已发出和棋请求');
}

function onDrawRequest() {
  dialog({
    title: '对方提议和棋',
    text: '接受后本局以和棋结束。',
    actions: [
      { label: '接受', kind: 'primary', onClick: () => {
        send({ t: 'draw-ack', ok: true });
        endGame(0, 'draw');
      } },
      { label: '拒绝', kind: 'ghost', onClick: () => send({ t: 'draw-ack', ok: false }) },
    ],
  });
}

function requestResign() {
  dialog({
    title: '确认认输？',
    text: '认输后本局判对方获胜。',
    actions: [
      { label: '确认认输', kind: 'danger', onClick: () => {
        send({ t: 'resign' });
        endGame(oppColor(), 'resign');
      } },
      { label: '再想想', kind: 'ghost', onClick: () => {} },
    ],
  });
}

function onRemoteResign() {
  if (S.game?.status !== 'playing') return;
  endGame(myColor(), 'resign');
}

function onRemoteTimeout(msg) {
  if (S.game?.status !== 'playing') return;
  S.game.status = 'ended';
  S.game.winner = msg.winner;
  S.game.reason = 'timeout';
  S.game.deadline = 0;
  draw(); renderHud(); showResult();
}

function onAck(msg, kind) {
  if (!S.pending || S.pending.kind !== kind) return;
  const pending = S.pending;
  clearTimeout(pending.timer);
  S.pending = null;

  if (!msg.ok) {
    toast(kind === 'undo' ? '对方拒绝了悔棋' : kind === 'draw' ? '对方拒绝和棋' : '对方暂时不想再来一局');
    renderHud();
    return;
  }

  if (kind === 'undo') {
    undoFor(pending.data.color);
    draw(); renderHud();
  } else if (kind === 'draw') {
    endGame(0, 'draw');
  } else if (kind === 'restart') {
    startRound((S.game?.round ?? 0) + 1, false);
  }
}

function requestRestart() {
  send({ t: 'restart-req' });
  setPending('restart');
  toast('已邀请对方再来一局');
  if (S.game) S.game.status = 'ended';
  dialog({
    title: '等待对手同意…',
    text: '对方接受后自动开始新的一局，黑白交换。',
    actions: [{ label: '取消', kind: 'ghost', onClick: () => {
      clearPending(true);
      showResult();
    } }],
  });
}

function onRestartRequest() {
  dialog({
    title: '对方想再来一局',
    text: '接受后立刻开始新局，双方黑白互换。',
    actions: [
      { label: '来！', kind: 'primary', onClick: () => {
        send({ t: 'restart-ack', ok: true });
        startRound((S.game?.round ?? 0) + 1, false);
      } },
      { label: '不打了', kind: 'ghost', onClick: () => send({ t: 'restart-ack', ok: false }) },
    ],
  });
}

function endGame(winner, reason) {
  const g = S.game;
  if (!g) return;
  g.status = 'ended';
  g.winner = winner;
  g.reason = reason;
  g.deadline = 0;
  draw();
  renderHud();
  showResult();
}

function showResult() {
  const g = S.game;
  if (!g) return;

  const key = `${g.round}:${g.winner}:${g.reason}`;
  if (S.resultKey === key) return;
  S.resultKey = key;

  const mc = myColor();
  let title;
  if (g.winner === 0) title = '和棋';
  else if (g.winner === mc) title = '你赢了';
  else title = '你输了';

  const reasonText = {
    five: g.winner === 0 ? '' : `${g.winner === mc ? '你' : '对手'}连成五子`,
    full: '棋盘下满了，没人连成五子',
    resign: g.winner === mc ? '对手认输了' : '你认输了',
    timeout: g.winner === mc ? '对手超时' : '你超时了',
    draw: '双方同意和棋',
  }[g.reason] || '';

  // 晚一点再弹，先让人看清楚最后一手和胜利连线
  setTimeout(() => {
    if (S.game !== g || S.resultKey !== key) return;
    dialog({
      title,
      text: reasonText,
      actions: [
        { label: '再来一局', kind: 'primary', onClick: requestRestart },
        { label: '离开房间', kind: 'ghost', onClick: leaveRoom },
      ],
    });
  }, 850);
}

/* ══════════════ 快捷语 ══════════════ */

function bubble(text, mine) {
  const node = document.createElement('div');
  node.className = 'bubble' + (mine ? ' mine' : '');
  node.textContent = text;
  el.bubbles.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 380);
  }, 2600);
}

function sendChat(text) {
  send({ t: 'chat', text });
  bubble(text, true);
}

/* ══════════════ 棋盘绘制 ══════════════ */

const canvas = el.canvas;
const ctx = canvas.getContext('2d');

const geom = { size: 0, pad: 0, cell: 0, dpr: 1 };

function layoutBoard() {
  const wrap = canvas.closest('.board-wrap');
  const availW = wrap.clientWidth;
  const availH = wrap.clientHeight - 26;   // 给棋盘下方那行小字留位置
  const side = Math.max(200, Math.floor(Math.min(availW, availH)));

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  geom.size = side;
  geom.dpr = dpr;
  geom.pad = side / (SIZE + 1);
  geom.cell = (side - geom.pad * 2) / (SIZE - 1);

  canvas.style.width = side + 'px';
  canvas.style.height = side + 'px';
  canvas.width = Math.round(side * dpr);
  canvas.height = Math.round(side * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  draw();
}

const px = (i) => geom.pad + i * geom.cell;

/** 圆角矩形路径（兼容不支持 ctx.roundRect 的浏览器） */
function boardRoundRect(c, w, h, r) {
  c.beginPath();
  if (typeof c.roundRect === 'function') {
    c.roundRect(0, 0, w, h, r);
    return;
  }
  c.moveTo(r, 0);
  c.lineTo(w - r, 0);
  c.quadraticCurveTo(w, 0, w, r);
  c.lineTo(w, h - r);
  c.quadraticCurveTo(w, h, w - r, h);
  c.lineTo(r, h);
  c.quadraticCurveTo(0, h, 0, h - r);
  c.lineTo(0, r);
  c.quadraticCurveTo(0, 0, r, 0);
  c.closePath();
}

function draw() {
  if (!geom.size) return;
  const g = S.game;
  const size = geom.size;

  ctx.clearRect(0, 0, size, size);

  // 木纹底
  const bg = ctx.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, '#EFCE9D');
  bg.addColorStop(0.45, '#E6C08A');
  bg.addColorStop(1, '#D3A468');
  ctx.fillStyle = bg;
  boardRoundRect(ctx, size, size, 15);
  ctx.fill();

  // 细木纹
  ctx.save();
  boardRoundRect(ctx, size, size, 15);
  ctx.clip();
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = '#7a4a15';
  ctx.lineWidth = 1;
  for (let i = 0; i < 26; i++) {
    const y = (size / 26) * i + ((i * 37) % 7) - 3;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(size * 0.3, y + 4, size * 0.7, y - 4, size, y + 2);
    ctx.stroke();
  }
  ctx.restore();

  // 网格
  ctx.strokeStyle = 'rgba(92, 58, 22, .58)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < SIZE; i++) {
    const p = px(i);
    ctx.moveTo(px(0), p);
    ctx.lineTo(px(SIZE - 1), p);
    ctx.moveTo(p, px(0));
    ctx.lineTo(p, px(SIZE - 1));
  }
  ctx.stroke();

  // 外框
  ctx.strokeStyle = 'rgba(92, 58, 22, .85)';
  ctx.lineWidth = 1.6;
  ctx.strokeRect(px(0), px(0), geom.cell * (SIZE - 1), geom.cell * (SIZE - 1));

  // 星位
  ctx.fillStyle = 'rgba(80, 48, 16, .9)';
  for (const [x, y] of [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]]) {
    ctx.beginPath();
    ctx.arc(px(x), px(y), Math.max(2, geom.cell * 0.09), 0, Math.PI * 2);
    ctx.fill();
  }

  if (!g) return;

  // 棋子
  const r = geom.cell * 0.44;
  for (let i = 0; i < g.board.length; i++) {
    const v = g.board[i];
    if (!v) continue;
    drawStone(px(i % SIZE), px(Math.floor(i / SIZE)), r, v);
  }

  // 悬停预览（桌面）
  if (S.hover && g.status === 'playing' && g.turn === myColor() && peerOnline()) {
    const [hx, hy] = S.hover;
    if (inBounds(hx, hy) && g.board[idx(hx, hy)] === EMPTY) {
      ctx.save();
      ctx.globalAlpha = 0.32;
      drawStone(px(hx), px(hy), r, myColor());
      ctx.restore();
    }
  }

  // 最后一手标记
  if (g.moves.length >= 2) {
    const lx = g.moves[g.moves.length - 2];
    const ly = g.moves[g.moves.length - 1];
    const c = g.board[idx(lx, ly)];
    ctx.beginPath();
    ctx.arc(px(lx), px(ly), r * 0.24, 0, Math.PI * 2);
    ctx.fillStyle = c === BLACK ? 'rgba(255, 240, 210, .92)' : 'rgba(40, 30, 20, .8)';
    ctx.fill();
  }

  // 胜利连线
  if (g.winLine && g.winLine.length >= 2) {
    const first = g.winLine[0];
    const last = g.winLine[g.winLine.length - 1];
    ctx.save();
    ctx.strokeStyle = 'rgba(190, 64, 46, .70)';
    ctx.lineWidth = Math.max(2, geom.cell * 0.062);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(px(first[0]), px(first[1]));
    ctx.lineTo(px(last[0]), px(last[1]));
    ctx.stroke();
    ctx.restore();

    for (const [x, y] of g.winLine) {
      ctx.beginPath();
      ctx.arc(px(x), px(y), r * 0.98, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(206, 78, 58, .85)';
      ctx.lineWidth = Math.max(1.5, geom.cell * 0.045);
      ctx.stroke();
    }
  }
}

function drawStone(cx, cy, r, color) {
  // 投影用 shadowBlur 而非 canvas filter —— Safari 至今不支持 filter
  ctx.save();
  ctx.shadowColor = 'rgba(58, 36, 12, .42)';
  ctx.shadowBlur = r * 0.62;
  ctx.shadowOffsetX = r * 0.12;
  ctx.shadowOffsetY = r * 0.2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color === BLACK ? '#0d0d0d' : '#F1ECE4';
  ctx.fill();
  ctx.restore();

  const grad = ctx.createRadialGradient(
    cx - r * 0.34, cy - r * 0.38, r * 0.08,
    cx, cy, r * 1.05
  );

  if (color === BLACK) {
    grad.addColorStop(0, '#6E6E6E');
    grad.addColorStop(0.35, '#2B2B2B');
    grad.addColorStop(1, '#080808');
  } else {
    grad.addColorStop(0, '#FFFFFF');
    grad.addColorStop(0.55, '#F2EEE7');
    grad.addColorStop(1, '#C8C2B8');
  }

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.strokeStyle = color === BLACK ? 'rgba(0,0,0,.55)' : 'rgba(120, 110, 96, .45)';
  ctx.lineWidth = 0.7;
  ctx.stroke();

  // 高光
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.3, cy - r * 0.34, r * 0.3, r * 0.2, -0.6, 0, Math.PI * 2);
  ctx.fillStyle = color === BLACK ? 'rgba(255,255,255,.22)' : 'rgba(255,255,255,.85)';
  ctx.fill();
}

/* ══════════════ 棋盘交互 ══════════════ */

function pointFromEvent(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const cx = Math.round((x - geom.pad) / geom.cell);
  const cy = Math.round((y - geom.pad) / geom.cell);
  if (!inBounds(cx, cy)) return null;
  // 距离最近交叉点太远则忽略
  const dx = Math.abs(x - px(cx));
  const dy = Math.abs(y - px(cy));
  if (dx > geom.cell * 0.5 || dy > geom.cell * 0.5) return null;
  return [cx, cy];
}

canvas.addEventListener('pointerdown', (ev) => {
  ev.preventDefault();
  const pt = pointFromEvent(ev);
  if (pt) tryPlay(pt[0], pt[1]);
});

canvas.addEventListener('pointermove', (ev) => {
  if (ev.pointerType === 'touch') return;
  const pt = pointFromEvent(ev);
  const changed = (pt?.[0] ?? -1) !== (S.hover?.[0] ?? -1) ||
                  (pt?.[1] ?? -1) !== (S.hover?.[1] ?? -1);
  if (changed) {
    S.hover = pt;
    draw();
    canvas.style.cursor = pt ? 'pointer' : 'default';
  }
});

canvas.addEventListener('pointerleave', () => {
  if (S.hover) { S.hover = null; draw(); }
});

/* ══════════════ 会话持久化 ══════════════ */

function saveSession() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(S.session)); } catch {}
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
}

function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

/* ══════════════ 房间流程 ══════════════ */

function buildShareLink() {
  const base = location.origin + location.pathname;
  return `${base}#r=${S.session.roomId}`;
}

function renderRoomMeta() {
  el.roomChip.textContent = '房间 ' + S.session.roomId.slice(0, 6).toUpperCase();
  const t = S.settings.time;
  el.ruleChip.textContent = t === 0 ? '不限时' : `${t} 秒 / 步` + (S.settings.timeoutLose ? ' · 超时判负' : '');
}

function hostRoom() {
  S.settings = {
    time: Number(el.timeOptions.querySelector('.on')?.dataset.time ?? 30),
    timeoutLose: el.timeoutLose.checked,
  };

  S.session = { roomId: randId(20), role: 'host', playerId: randId(12) };
  S.guestId = null;
  S.game = null;
  S.peerId = null;
  S.peerSeen = 0;
  S.lastSeq = Object.create(null);

  saveSession();
  history.replaceState(null, '', `#r=${S.session.roomId}`);

  el.shareLink.value = buildShareLink();
  renderRoomMeta();
  showScreen('lobby');
  setConn('connecting');
  connect();
}

function joinRoom(roomId) {
  const stored = loadSession();
  const role = stored && stored.roomId === roomId ? stored.role : 'guest';
  const playerId = stored && stored.roomId === roomId ? stored.playerId : randId(12);

  S.session = { roomId, role, playerId };
  if (role === 'guest') S.guestId = null;
  S.game = null;
  S.peerId = null;
  S.peerSeen = 0;
  S.lastSeq = Object.create(null);

  saveSession();

  el.shareLink.value = buildShareLink();
  renderRoomMeta();
  showScreen('lobby');
  el.lobbyStatus.textContent = role === 'host' ? '正在恢复房间…' : '正在进入房间…';
  setConn('connecting');
  connect();
}

function leaveRoom() {
  endPresence();
  disconnect();
  clearSession();
  S.game = null;
  S.session = null;
  S.peerId = null;
  S.pending = null;
  history.replaceState(null, '', location.pathname);
  showScreen('home');
  closeDialog();
  refreshResumeButton();
}

function refreshResumeButton() {
  const stored = loadSession();
  el.btnResume.classList.toggle('hidden', !stored);
}

/* ══════════════ 心跳与在线状态 ══════════════ */

let heartbeat = null;

function startPresence() {
  endPresence();
  heartbeat = setInterval(() => {
    if (!S.session) return;
    send({ t: 'ping', ts: Date.now() });

    // 还在等待页就继续打招呼：防止握手时对方恰好没收到
    if (currentScreen === 'lobby') {
      send({ t: 'hello', proto: PROTO, role: S.session.role });
    }

    // 对局中每 15 秒推一次整盘：万一某条落子消息丢了，能自动对齐回来
    if (currentScreen === 'game' && S.game && S.game.status === 'playing') {
      S.syncTick = (S.syncTick || 0) + 1;
      if (S.syncTick % 3 === 0) sendState();
    }

    if (S.peerId && Date.now() - S.peerSeen > PEER_TIMEOUT_MS) {
      renderHud();
    }
  }, PING_MS);
}

function endPresence() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

/* ══════════════ 事件绑定 ══════════════ */

el.timeOptions.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-time]');
  if (!btn) return;
  el.timeOptions.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
});

el.btnCreate.addEventListener('click', hostRoom);

el.btnResume.addEventListener('click', () => {
  const stored = loadSession();
  if (stored?.roomId) joinRoom(stored.roomId);
});

el.btnCopy.addEventListener('click', async () => {
  const link = el.shareLink.value;
  try {
    await navigator.clipboard.writeText(link);
    toast('链接已复制，发给朋友吧');
  } catch {
    el.shareLink.select();
    el.shareLink.setSelectionRange(0, 9999);
    try {
      document.execCommand('copy');
      toast('链接已复制');
    } catch {
      toast('复制失败，请长按链接手动复制');
    }
  }
});

el.btnLeaveLobby.addEventListener('click', () => {
  dialog({
    title: '离开房间？',
    text: '离开后这个房间会关闭，需要重新创建。',
    actions: [
      { label: '离开', kind: 'danger', onClick: leaveRoom },
      { label: '留下', kind: 'ghost', onClick: () => {} },
    ],
  });
});

el.btnUndo.addEventListener('click', requestUndo);
el.btnDraw.addEventListener('click', requestDraw);
el.btnResign.addEventListener('click', requestResign);

el.btnChat.addEventListener('click', () => {
  el.quickChat.classList.toggle('hidden');
});

for (const phrase of QUICK_PHRASES) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = phrase;
  btn.addEventListener('click', () => {
    sendChat(phrase);
    el.quickChat.classList.add('hidden');
  });
  el.quickRow.appendChild(btn);
}

document.addEventListener('pointerdown', (e) => {
  if (el.quickChat.classList.contains('hidden')) return;
  if (el.quickChat.contains(e.target) || el.btnChat.contains(e.target)) return;
  el.quickChat.classList.add('hidden');
});

/* 屏幕尺寸变化 */
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (currentScreen === 'game') layoutBoard();
  }, 120);
});

/* 切到后台再回来：立刻重建连接（iOS 会挂起 WebSocket） */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!S.session) return;
  if (S.net && S.net.connected) {
    send({ t: 'hello', proto: PROTO, role: S.session.role });
    if (S.game) sendState();
  } else {
    setConn('connecting');
    connect();
  }
});

window.addEventListener('beforeunload', () => {
  safe(() => S.net?.end(true));
});

/* ══════════════ 启动 ══════════════ */

/* 调试钩子：方便自动化测试和线上排查，不参与正常流程 */
window.__gomoku = {
  get snapshot() {
    return {
      screen: currentScreen,
      conn: S.conn,
      peer: S.peerId,
      session: S.session,
      game: S.game && {
        board: Array.from(S.game.board),
        moves: S.game.moves.slice(),
        turn: S.game.turn,
        status: S.game.status,
        winner: S.game.winner,
        reason: S.game.reason,
        round: S.game.round,
        rev: S.game.rev,
        settings: S.game.settings,
      },
    };
  },
  play: (x, y) => tryPlay(x, y),
  layout: () => ({ ...geom }),
  get trace() { return traceLog.slice(); },
};

window.addEventListener('error', (e) => trace('!', 'error:' + e.message));
window.addEventListener('unhandledrejection', (e) => trace('!', 'reject:' + (e.reason?.message || e.reason)));

function boot() {
  refreshResumeButton();

  const hash = new URLSearchParams(location.hash.slice(1));
  const roomId = hash.get('r');

  if (roomId && /^[a-z0-9]{8,32}$/i.test(roomId)) {
    joinRoom(roomId.toLowerCase());
  } else {
    showScreen('home');
  }

  startPresence();
}

boot();
