// SPDX-License-Identifier: MIT
// INTERNAL tooling — terminal rendering helpers. Pure functions, no I/O.

/** ASCII progress bar. percent is 0-100. */
export function bar(percent: number, width = 28): string {
  const p = Math.max(0, Math.min(100, percent));
  const filled = Math.round((p / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Whole seconds remaining -> "m:ss". Uses ceil so it lands exactly on 0:00. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

/**
 * One status line. etaSeconds === null renders the honesty state
 * ("estimating…") instead of a fabricated number.
 */
export function progressLine(opts: {
  percent: number;
  etaSeconds: number | null | undefined;
  stage?: string | null;
}): string {
  const pct = `${String(Math.round(opts.percent)).padStart(3, " ")}%`;
  const eta =
    opts.etaSeconds === null || opts.etaSeconds === undefined
      ? "estimating…"
      : `${formatCountdown(opts.etaSeconds)} remaining`;
  const stage = opts.stage ? `  ${opts.stage}` : "";
  return `${bar(opts.percent)}  ${pct}   ${eta}${stage}`;
}

/** True when stdout is an interactive terminal (safe for \r redraws). */
export function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

/** Pad a line so a shorter redraw fully overwrites a longer previous one. */
export function clearPad(line: string, width = 100): string {
  return line.length >= width ? line : line + " ".repeat(width - line.length);
}
