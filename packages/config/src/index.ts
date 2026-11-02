export {
  applyLoggerRules,
  environmentEnvSchema,
  loggerEnvSchema,
  type NodeEnvironment,
} from './env.js';
export { connectionUrl, integerEnv } from './fields.js';
export { databaseEnvSchema, databaseUrlSchema } from './database.js';
export { redisEnvSchema, redisUrlSchema } from './redis.js';
export {
  loadConfigOrExit,
  toConfigValidationIssues,
  type ConfigExitTarget,
  type ConfigValidationIssue,
} from './load.js';

export type EnvironmentSource = Readonly<Record<string, string | undefined>>;
