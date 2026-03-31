export const OPCODE = {
  STATE: 1,
  MOVE: 2,
  PING: 3
} as const;

export type Opcode = (typeof OPCODE)[keyof typeof OPCODE];

