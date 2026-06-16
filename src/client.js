// SkribblClient — headless Socket.IO client for skribbl.io.
// Handles matchmaking, login, the heartbeat (via socket.io-client), and the
// `data`-event state machine. Emits clean semantic events for the bot logic.

import { EventEmitter } from 'node:events';
import { io } from 'socket.io-client';
import { requestServer } from './matchmaking.js';
import { makeAgent } from './proxy.js';
import { OP, STATE } from './protocol.js';

export class SkribblClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {number} [opts.lang=0]
   * @param {number[]} [opts.avatar=[27,30,2,-1]]
   */
  constructor({ name, lang = 0, avatar = [27, 30, 2, -1], proxy = '' }) {
    super();
    this.name = name;
    this.lang = lang;
    this.avatar = avatar;
    this.proxy = proxy;      // optional outbound proxy URL

    this.socket = null;
    /** @type {null | {settings:any,id:string,type:number,me:number,owner:number,users:any[]}} */
    this.room = null;
    this.me = null;          // our user id
    this.drawerId = null;    // current drawer's user id
    this.state = null;       // current STATE.* value
    this.word = null;        // [length] for guessers, or string when we draw
    this.hints = [];         // revealed-letter hints
  }

  get isDrawing() {
    return this.me != null && this.drawerId === this.me;
  }

  userName(id) {
    return this.room?.users.find((u) => u.id === id)?.name ?? `#${id}`;
  }

  /**
   * Join a game.
   * @param {object} [o]
   * @param {number} [o.create=0]  1 = create a private room
   * @param {string} [o.join='']   room code to join, "" = public matchmaking
   */
  async join({ create = 0, join = '' } = {}) {
    // proxy may be a string or a picker fn (re-evaluated each join → rotation)
    const proxyUrl = typeof this.proxy === 'function' ? this.proxy() : this.proxy;
    const { origin, path, raw } = await requestServer({
      name: this.name, lang: this.lang, create, join, avatar: this.avatar, proxy: proxyUrl,
    });
    this.emit('server', { origin, path, raw });

    const agent = await makeAgent(proxyUrl);   // route the websocket through the proxy
    this.socket = io(origin, {
      path,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      ...(agent ? { agent } : {}),
    });

    this.socket.on('connect', () => {
      this.emit('connect');
      this.socket.emit('login', {
        join, create,
        name: this.name,
        lang: String(this.lang),
        avatar: this.avatar,
      });
    });

    this.socket.on('disconnect', (reason) => this.emit('disconnect', reason));
    this.socket.on('connect_error', (err) => this.emit('error', err));

    // Every gameplay message arrives on the single `data` event.
    this.socket.on('data', (msg) => this._onData(msg));

    return this;
  }

  _onData({ id, data }) {
    this.emit('raw', { id, data }); // every frame, for BOT_DEBUG opcode capture
    switch (id) {
      case OP.HOST_STATE: {
        this.room = data;
        this.me = data.me;
        this.emit('lobby', data);
        break;
      }
      case OP.PLAYER_JOIN:
        this.room?.users.push(data);
        this.emit('playerJoin', data);
        break;
      case OP.PLAYER_LEFT:
        if (this.room) this.room.users = this.room.users.filter((u) => u.id !== data.id);
        this.emit('playerLeft', data);
        break;
      case OP.CHAT:
        this.emit('chat', { id: data.id, name: this.userName(data.id), msg: data.msg });
        break;
      case OP.GUESS_CORRECT:
        this.emit('guessedCorrect', data);
        break;
      case OP.VOTE:
        this.emit('vote', data);
        break;
      case OP.STATE:
        this._onState(data);
        break;
      case OP.HINTS:
        this._mergeHints(data);
        this.emit('hints', { word: this.word, hints: this.hints });
        break;
      case OP.TIMER:
        this.emit('timer', data);
        break;
      case OP.DRAW:
        this.emit('draw', data.data ?? data); // incoming stroke segments
        break;
      case OP.CLEAR:
        this.emit('clear', data);
        break;
      default:
        this.emit('unknown', { id, data });
    }
  }

  _onState({ id: state, time, data }) {
    this.state = state;
    switch (state) {
      case STATE.CHOOSE_WORD:
        this.drawerId = data?.id ?? null;
        // When it's OUR turn, the word choices ride along (shape TBD — log it).
        if (this.drawerId === this.me) this.emit('yourTurnChoose', { time, data });
        this.emit('turnStart', { drawerId: this.drawerId, time });
        break;
      case STATE.DRAWING:
        this.drawerId = data?.id ?? this.drawerId;
        this.word = data?.word ?? null;     // [len] for guessers, string for drawer
        this.hints = this._normalizeHints(data?.hints);
        this.emit('drawing', {
          drawerId: this.drawerId, word: this.word, hints: this.hints, time,
          drawCommands: data?.drawCommands ?? [],
        });
        break;
      case STATE.ROUND_END:
        this.emit('roundEnd', { word: data?.word, scores: data?.scores, reason: data?.reason });
        this.word = null; this.hints = []; this.drawerId = null;
        break;
      default:
        this.emit('state', { state, time, data });
    }
  }

  /** Normalize hints to [{char, position}]. Accepts [[pos,char],…] or [{char,position},…]. */
  _normalizeHints(hints) {
    if (!Array.isArray(hints)) return [];
    return hints.map((h) =>
      Array.isArray(h) ? { position: h[0], char: h[1] } : { position: h.position, char: h.char }
    ).filter((h) => Number.isInteger(h.position) && typeof h.char === 'string');
  }

  /** Merge an op13 reveal ([[pos,char],…]) into the accumulated hint set. */
  _mergeHints(data) {
    const incoming = this._normalizeHints(data);
    for (const h of incoming) {
      if (!this.hints.some((e) => e.position === h.position)) this.hints.push(h);
    }
  }

  // --- actions ---------------------------------------------------------------

  /** Send a chat message / guess. */
  guess(text) {
    this.socket?.emit('data', { id: OP.CHAT, data: String(text) });
  }

  /** Pick one of the offered words (0-based index) when it's our turn. */
  chooseWord(index) {
    this.socket?.emit('data', { id: OP.CHOOSE_WORD, data: index });
  }

  /** Send a batch of draw segments: [[tool,color,width,x1,y1,x2,y2], ...]. */
  draw(segments) {
    if (segments?.length) this.socket?.emit('data', { id: OP.DRAW, data: segments });
  }

  close() {
    this.socket?.close();
  }
}
