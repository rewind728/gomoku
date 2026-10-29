/**
 * 五子棋核心规则（无禁手）
 * 纯函数，不依赖 DOM，可在 Node 中直接测试。
 */

export const SIZE = 15;
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export const CELLS = SIZE * SIZE;

/** 无禁手规则：连成 5 子或以上（长连）都算赢 */
export const WIN_LEN = 5;

const DIRS = [
  [1, 0],   // 横
  [0, 1],   // 竖
  [1, 1],   // 撇
  [1, -1],  // 捺
];

export const idx = (x, y) => y * SIZE + x;

export const pointOf = (i) => ({ x: i % SIZE, y: Math.floor(i / SIZE) });

export const inBounds = (x, y) => x >= 0 && x < SIZE && y >= 0 && y < SIZE;

export const createBoard = () => new Uint8Array(CELLS);

export const stoneAt = (board, x, y) =>
  inBounds(x, y) ? board[idx(x, y)] : EMPTY;

export const isBoardFull = (board) => {
  for (let i = 0; i < CELLS; i++) if (board[i] === EMPTY) return false;
  return true;
};

/**
 * 判断某点落子后是否成五。
 * 返回构成连线的所有坐标数组（长连会返回全部），否则返回 null。
 */
export function findWin(board, x, y, color) {
  for (const [dx, dy] of DIRS) {
    const line = [[x, y]];

    // 正向
    let cx = x + dx;
    let cy = y + dy;
    while (inBounds(cx, cy) && board[idx(cx, cy)] === color) {
      line.push([cx, cy]);
      cx += dx;
      cy += dy;
    }

    // 反向
    cx = x - dx;
    cy = y - dy;
    while (inBounds(cx, cy) && board[idx(cx, cy)] === color) {
      line.unshift([cx, cy]);
      cx -= dx;
      cy -= dy;
    }

    if (line.length >= WIN_LEN) return line;
  }
  return null;
}

/** 落子是否合法（不检查轮次，轮次由调用方判断） */
export function isLegalMove(board, x, y) {
  return inBounds(x, y) && board[idx(x, y)] === EMPTY;
}
