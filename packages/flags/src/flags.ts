import { FLAG_KEYS, isFlagKey, type FlagKey } from './registry.ts';

/** Who a flag is evaluated for. Without a user, flags are evaluated for the server. */
export interface FlagContext {
  readonly distinctId?: string;
}

/** A remote flag service. Returns the flags it knows; anything missing falls to the default. */
export interface FlagSource {
  evaluate(
    keys: readonly FlagKey[],
    context: FlagContext,
  ): Promise<Partial<Record<FlagKey, boolean>>>;
}

export interface Flags {
  isEnabled(key: FlagKey, context?: FlagContext): Promise<boolean>;
}

export interface FlagsOptions {
  /** The remote source (PostHog), when configured. */
  readonly source?: FlagSource;
  /**
   * Overrides that beat the source, from FLAG_OVERRIDES: `shell.build-version=on,other=off`.
   * The way to flip a flag without a flag service, and a kill switch when it is down.
   */
  readonly overrides?: string;
  /** Give up on the source after this long and use the default. */
  readonly timeoutMs?: number;
  readonly log?: (message: string, error?: unknown) => void;
}

const ON = new Set(['on', 'true', '1']);
const OFF = new Set(['off', 'false', '0']);

/** Parses FLAG_OVERRIDES. Unknown flags and unreadable values are reported and ignored. */
export function parseOverrides(
  raw: string | undefined,
  log: (message: string) => void = () => {},
): Partial<Record<FlagKey, boolean>> {
  const overrides: Partial<Record<FlagKey, boolean>> = {};
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [key = '', value = 'on'] = trimmed.split('=').map((s) => s.trim());
    const v = value.toLowerCase();
    if (!isFlagKey(key)) {
      log(`FLAG_OVERRIDES: ignoring unknown flag "${key}"`);
    } else if (ON.has(v) || OFF.has(v)) {
      overrides[key] = ON.has(v);
    } else {
      log(`FLAG_OVERRIDES: ignoring "${trimmed}"; use on or off`);
    }
  }
  return overrides;
}

/**
 * Whether the operator has stopped an AI model for every organization: its switch,
 * `operator.<model id>`, is set off in FLAG_OVERRIDES (FR-INT-16). Unset or on, each
 * organization decides, so a model with no switch is never stopped.
 */
export function modelStopped(model: string, overrides: Partial<Record<FlagKey, boolean>>): boolean {
  const key = `operator.${model}`;
  return isFlagKey(key) && overrides[key] === false;
}

/**
 * Feature flags, evaluated on the server. An override wins, then the source, then the
 * default, which is always off. A source that fails or is slow never breaks a request:
 * the flag reads as off, so new code stays dark rather than half-released.
 */
export function createFlags(options: FlagsOptions = {}): Flags {
  const log = options.log ?? ((message, error) => console.warn(message, error ?? ''));
  const overrides = parseOverrides(options.overrides, log);
  const timeoutMs = options.timeoutMs ?? 500;
  const { source } = options;

  return {
    async isEnabled(key, context = {}) {
      const override = overrides[key];
      if (override !== undefined) return override;
      if (!source) return false;
      try {
        const values = await withTimeout(source.evaluate(FLAG_KEYS, context), timeoutMs);
        return values[key] ?? false;
      } catch (error) {
        log(`Flags: evaluating "${key}" failed; using the default (off)`, error);
        return false;
      }
    },
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
