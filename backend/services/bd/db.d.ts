// backend/services/db.d.ts
import { Pool, QueryResult } from 'pg';

declare const db: {
  query<T = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
  pool: Pool;
};

export default db; 