import type { INestApplication, LogLevel } from '@nestjs/common';

const DEFAULT_LOG_LEVEL_PROFILE = 'standard';
const LOGGER_LEVELS_BY_PROFILE = {
  minimal: ['fatal', 'error', 'warn'],
  standard: ['fatal', 'error', 'warn', 'log'],
  verbose: ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'],
} as const satisfies Record<string, readonly LogLevel[]>;

/** Applies the shared HTTP configuration used by production and test applications. */
export function configureApplication(application: INestApplication): void {
  application.enableCors({
    origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  });
  application.setGlobalPrefix('api');
}

/** Resolves configurable Nest logger levels without requiring code changes. */
export function resolveLoggerLevels(
  configuredLogLevel: string | undefined,
): LogLevel[] {
  const requestedProfile =
    configuredLogLevel?.trim().toLowerCase() ?? DEFAULT_LOG_LEVEL_PROFILE;
  const resolvedProfile = isLogLevelProfile(requestedProfile)
    ? requestedProfile
    : DEFAULT_LOG_LEVEL_PROFILE;

  return [...LOGGER_LEVELS_BY_PROFILE[resolvedProfile]];
}

function isLogLevelProfile(
  value: string,
): value is keyof typeof LOGGER_LEVELS_BY_PROFILE {
  return Object.hasOwn(LOGGER_LEVELS_BY_PROFILE, value);
}
