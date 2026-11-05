// Forkline regression suite. Run with `npm run regression`, before every engine upgrade.
// Flags (after `--`):  --only 3,9   --skip 13   --list   --record-baseline   --wrong 12   --keep
// Live calls use Haiku, except check 13, which calls each configured model once.
import { execFileSync } from 'node:child_process';
import { SDK_VERSION } from '../../src/constants.js';
import { allChecks } from './checks/index.js';
import { Failure, Skip, StopSuite, makeContext } from './harness.js';

interface Args {
  only: string[] | null;
  skip: string[];
  list: boolean;
  recordBaseline: boolean;
  wrong: string | null;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { only: null, skip: [], list: false, recordBaseline: false, wrong: null, keep: false };
  const value = (i: number): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${argv[i]} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--only') args.only = value(i++).split(',');
    else if (arg === '--skip') args.skip = value(i++).split(',');
    else if (arg === '--wrong') args.wrong = value(i++);
    else if (arg === '--list') args.list = true;
    else if (arg === '--record-baseline') args.recordBaseline = true;
    else if (arg === '--keep') args.keep = true;
    else throw new Error(`unknown flag ${arg}`);
  }
  return args;
}

type Outcome = 'PASS' | 'FAIL' | 'SKIP' | 'STOP';
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

function leftoverChildren(): string[] {
  try {
    return execFileSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function describe(pids: string[]): string {
  try {
    return execFileSync('ps', ['-o', 'comm=', '-p', pids.join(',')], { encoding: 'utf8' }).trim().replace(/\n/g, ', ');
  } catch {
    return 'gone';
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const checks = allChecks({ recordBaseline: args.recordBaseline });
  if (args.list) {
    for (const check of checks) console.log(`${check.id.padStart(2)}  ${check.title}  [${check.cost}]`);
    return 0;
  }
  const known = new Set(checks.map((c) => c.id));
  for (const id of [...(args.only ?? []), ...args.skip, ...(args.wrong ? [args.wrong] : [])]) {
    if (!known.has(id)) throw new Error(`no check ${id}; --list shows them`);
  }
  const selected = checks.filter((c) => (args.only ? args.only.includes(c.id) : true) && !args.skip.includes(c.id));

  // Children that exist before any check runs (tsx's esbuild) are not ours to judge.
  const preexisting = new Set(leftoverChildren());
  const ours = (): string[] => leftoverChildren().filter((pid) => !preexisting.has(pid));
  let stopped = false;
  const { ctx, cleanup } = makeContext({ wrong: false, note: (text) => console.log(`        ${text}`) });
  console.log(`Forkline regression suite: SDK ${SDK_VERSION}, ${selected.length} checks${args.wrong ? `, check ${args.wrong} deliberately wrong` : ''}`);
  const results: { id: string; outcome: Outcome; line: string }[] = [];

  const onSignal = (): void => {
    stopped = true;
    console.log('\ninterrupted; finishing the current call and stopping');
  };
  process.once('SIGINT', onSignal);

  try {
    for (const check of selected) {
      if (stopped) {
        results.push({ id: check.id, outcome: 'STOP', line: 'not run' });
        console.log(`STOP  ${check.id.padStart(2)}  ${check.title}: not run`);
        continue;
      }
      ctx.wrong = args.wrong === check.id;
      const start = Date.now();
      let outcome: Outcome;
      let detail: string;
      try {
        detail = (await check.run(ctx)) ?? '';
        outcome = 'PASS';
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (cause instanceof Skip) {
          outcome = 'SKIP';
          detail = message;
        } else if (cause instanceof StopSuite) {
          outcome = 'STOP';
          detail = message;
          stopped = true;
        } else if (cause instanceof Failure) {
          outcome = 'FAIL';
          detail = message;
        } else {
          outcome = 'FAIL';
          detail = `unexpected error: ${message}`;
        }
      }
      const line = `${outcome}  ${check.id.padStart(2)}  ${check.title}: ${detail} (${seconds(Date.now() - start)})`;
      results.push({ id: check.id, outcome, line });
      console.log(line);
    }
  } finally {
    process.removeListener('SIGINT', onSignal);
    if (!args.keep) cleanup();
  }

  // Claude Code processes end a moment after an abort; give them a few seconds, then report any left.
  for (let i = 0; i < 50 && ours().length > 0; i++) await new Promise((r) => setTimeout(r, 100));
  const left = ours();
  if (left.length > 0) {
    console.log(`warning: ${left.length} child process(es) still running (${left.join(', ')}: ${describe(left)}); stopping them`);
    for (const pid of left) {
      try {
        process.kill(Number(pid), 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }

  const count = (o: Outcome): number => results.filter((r) => r.outcome === o).length;
  console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped${count('STOP') ? `, ${count('STOP')} stopped (usage limit or interrupt)` : ''}; ${ctx.liveCalls.count} live runs`);
  for (const r of results.filter((x) => x.outcome === 'FAIL' || x.outcome === 'STOP')) console.log(`  ${r.line}`);
  return count('FAIL') > 0 || count('STOP') > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (cause: unknown) => {
    console.error(`regression suite could not start: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(2);
  },
);
