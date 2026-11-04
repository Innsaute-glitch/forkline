import type { Ctx } from '../harness.js';

export interface Check {
  /** Brief section 12 number, or a letter for the checks the plan adds. */
  id: string;
  title: string;
  /** Which models the check calls live, for the cost line in `--list`. */
  cost: string;
  /** Returns a short result detail shown on the PASS line. Throws Failure, Skip or StopSuite. */
  run(ctx: Ctx): Promise<string | void>;
}
