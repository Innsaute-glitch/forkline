import { check13 } from './models.js';
import { check1, check14, check2, check3, check4, check5 } from './history.js';
import { check8, check9, check10, makeCheck11 } from './content.js';
import { check12, check15, check16, check6, check7 } from './session.js';
import type { Check } from './types.js';

/** Checks 1 to 16, in order. */
export function allChecks(options: { recordBaseline: boolean }): Check[] {
  return [
    check1, check2, check3, check4, check5, check6, check7, check8, check9, check10,
    makeCheck11(options), check12, check13, check14, check15, check16,
  ];
}
