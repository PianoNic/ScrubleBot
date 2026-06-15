// skribbl.io Socket.IO wire protocol — reverse-engineered 2026-06-15.
// All gameplay multiplexes through a single Socket.IO event: "data",
// carrying { id: <opcode>, data: <payload> }. See README for the full map.

/** Opcodes for the "data" event (both directions unless noted). */
export const OP = {
  // --- receive ---
  HOST_STATE: 10,     // full lobby snapshot on join {settings,id,type,me,owner,users[]}
  PLAYER_JOIN: 1,     // {id,name,avatar,score,guessed,flags}
  PLAYER_LEFT: 2,     // {id, reason}
  VOTE: 8,            // like/dislike {id, vote}
  GUESS_CORRECT: 15,  // {id} — player guessed the word (likely; verify)
  CHAT: 30,           // recv {id,msg}; SEND a guess = emit data {id:30, data:"<text>"}
  STATE: 11,          // game state machine {id:<STATE>, time, data}
  HINTS: 13,          // hint reveal — data = [[position, char], ...]
  TIMER: 14,          // round timer tick — data = <seconds> (bare number)
  CLEAR: 21,          // canvas/word-bank related tick — data = <number> (TBD)

  // --- send ---
  CHOOSE_WORD: 18,    // emit data {id:18, data:<wordIndex>}
  DRAW: 19,           // draw/recv {id:19, data:[[tool,color,width,x1,y1,x2,y2], ...]}
};

/** Sub-states carried by OP.STATE (opcode 11). */
export const STATE = {
  CHOOSE_WORD: 3,     // drawer is picking {data:{id:drawerId}}, time = secs
  DRAWING: 4,         // {data:{id:drawerId, word:[len]|string, hints:[], drawCommands:[]}}
  ROUND_END: 5,       // {data:{reason, word:"<answer>", scores:[id,total,gain,...]}}
};

/** Draw tool codes inside OP.DRAW segments (segment = [tool,color,width,x1,y1,x2,y2]). */
export const TOOL = {
  PEN: 0,
  // FILL / CLEAR / UNDO codes still to be confirmed empirically
};

/** skribbl's default 22-colour palette (index → #hex), used by OP.DRAW `color`. */
export const PALETTE = [
  '#ffffff', '#000000', '#c1c1c1', '#4c4c4c',
  '#ef130b', '#740b07', '#ff7100', '#c23800',
  '#ffe400', '#e8a200', '#00cc00', '#005510',
  '#00b2ff', '#00569e', '#231fd3', '#0e0865',
  '#a300ba', '#550069', '#d37caa', '#a75574',
  '#a0522d', '#63300d',
];

/** Canvas dimensions skribbl draws on (coordinate space for OP.DRAW). */
export const CANVAS = { width: 800, height: 600 };
