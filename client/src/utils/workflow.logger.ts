const LOG_LEVEL_PRIORITY = {
  silent: 0,
  error: 1,
  warn: 2,
} as const;

type WorkflowLogLevel = keyof typeof LOG_LEVEL_PRIORITY;

function resolveConfiguredLogLevel(): WorkflowLogLevel {
  const configuredLogLevel = import.meta.env.VITE_LOG_LEVEL?.toLowerCase();
  return configuredLogLevel === 'silent' || configuredLogLevel === 'warn' || configuredLogLevel === 'error'
    ? configuredLogLevel
    : 'error';
}

function canLog(logLevel: Exclude<WorkflowLogLevel, 'silent'>): boolean {
  return LOG_LEVEL_PRIORITY[resolveConfiguredLogLevel()] >= LOG_LEVEL_PRIORITY[logLevel];
}

/**
 * Records a recoverable workflow boundary failure without exposing submitted URLs
 * or HTTP response payloads.
 */
export function logWorkflowWarning(operation: string, jobId?: string): void {
  if (!canLog('warn')) return;
  console.warn(`[workflow.${operation}] Recoverable request failure`, { jobId });
}

/**
 * Records an unexpected workflow boundary failure with only safe operation context.
 */
export function logWorkflowError(operation: string, error: unknown, jobId?: string): void {
  if (!canLog('error')) return;
  const errorName = error instanceof Error ? error.name : 'UnknownError';
  console.error(`[workflow.${operation}] Request failed`, { jobId, errorName });
}