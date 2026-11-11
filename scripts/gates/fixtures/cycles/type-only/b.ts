import { type CycleA } from './a.ts';

export interface CycleB {
  readonly a: CycleA;
}
