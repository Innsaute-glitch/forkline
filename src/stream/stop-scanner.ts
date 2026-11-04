// Pure stop-string scanner. No I/O. Lengths are UTF-16 code units.

export interface ScanResult {
  /** Text safe to send now. */
  emit: string;
  /** True when a stop string matched; `emit` is then the text before the match and the scanner is finished. */
  matched: boolean;
}

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;

export class StopScanner {
  private readonly stops: string[];
  private readonly hold: number;
  private held = '';
  private finished = false;

  constructor(stops: readonly string[]) {
    this.stops = stops.filter((stop) => stop.length > 0);
    this.hold = this.stops.reduce((max, stop) => Math.max(max, stop.length), 0) - 1;
    if (this.hold < 0) this.hold = 0;
  }

  /** Feed one chunk. The earliest match wins, whatever the chunking. */
  push(text: string): ScanResult {
    if (this.finished) return { emit: '', matched: false };
    const buffer = this.held + text;
    const idx = this.earliestMatch(buffer);
    if (idx !== -1) {
      const partial = this.earliestPartial(buffer);
      // A longer stop that started earlier could still complete: wait.
      if (partial === -1 || idx <= partial) {
        this.finished = true;
        this.held = '';
        return { emit: buffer.slice(0, idx), matched: true };
      }
    }
    let release = Math.max(0, buffer.length - this.hold);
    // Never end a released chunk on a high surrogate: hold it with its pair.
    if (release > 0 && isHighSurrogate(buffer.charCodeAt(release - 1))) release -= 1;
    this.held = buffer.slice(release);
    return { emit: buffer.slice(0, release), matched: false };
  }

  /** The run ended: release held text. A pending full match is valid now. */
  flush(): ScanResult {
    if (this.finished) return { emit: '', matched: false };
    const buffer = this.held;
    this.held = '';
    this.finished = true;
    const idx = this.earliestMatch(buffer);
    if (idx !== -1) return { emit: buffer.slice(0, idx), matched: true };
    return { emit: buffer, matched: false };
  }

  private earliestMatch(buffer: string): number {
    let best = -1;
    for (const stop of this.stops) {
      const at = buffer.indexOf(stop);
      if (at !== -1 && (best === -1 || at < best)) best = at;
    }
    return best;
  }

  /** Start of the earliest suffix that is a proper prefix of some stop, or -1. */
  private earliestPartial(buffer: string): number {
    for (let j = Math.max(0, buffer.length - this.hold); j < buffer.length; j += 1) {
      const suffix = buffer.slice(j);
      if (this.stops.some((stop) => stop.length > suffix.length && stop.startsWith(suffix))) return j;
    }
    return -1;
  }
}
