import type { CycleB } from './b.ts';

export interface CycleA {
  readonly b: CycleB;
}
