export {
  createPool,
  QUERY_TIMEOUT_MARGIN_MS,
  type DatabaseOptions,
  checkDatabaseHealth,
  type DatabaseLogger,
  closeDatabase,
} from './db/pool.js';
export type { Pool } from 'pg';
