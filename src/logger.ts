export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(level: LogLevel = 'info'): Logger {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const log = (lvl: LogLevel, method: 'log' | 'warn' | 'error', args: unknown[]) => {
    if (LEVELS[lvl] < threshold) return;
    // eslint-disable-next-line no-console
    console[method](`[${lvl}]`, ...args);
  };

  return {
    debug: (...args) => log('debug', 'log', args),
    info: (...args) => log('info', 'log', args),
    warn: (...args) => log('warn', 'warn', args),
    error: (...args) => log('error', 'error', args),
  };
}
