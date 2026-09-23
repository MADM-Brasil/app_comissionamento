// services/db.js
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

// ─── Configuração da conexão ───────────────────────────────────
const connectionString = process.env.DATABASE_URL;

let dbConfig;
if (connectionString) {
  // Se DATABASE_URL existe, usa ela
  // SSL é controlado pela variável DB_SSL (default: false)
  const useSSL = process.env.DB_SSL === 'true';
  dbConfig = {
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
  };
} else {
  // Desenvolvimento local – monta a partir de variáveis individuais
  const dbPassword = process.env.DB_PASSWORD || '';
  if (typeof dbPassword !== 'string') {
    console.error('❌ DB_PASSWORD não é uma string:', typeof dbPassword);
    process.exit(1);
  }

  dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: dbPassword,
    database: process.env.DB_NAME || 'madm',
    ssl: false,
  };
}

// ─── Criação do pool ───────────────────────────────────────────
const pool = new Pool({
  ...dbConfig,
  max: Number(process.env.DB_POOL_MAX || 20),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on('connect', () => {
  console.log('✅ Conectado ao PostgreSQL com sucesso');
});

pool.on('error', (err) => {
  console.error('❌ Erro inesperado no pool do PostgreSQL:', err);
  console.warn('⚠️ O cliente afetado foi descartado. O pool tentará estabelecer uma nova conexão na próxima operação.');
});

export async function waitForDatabase({ retryDelayMs = 5000 } = {}) {
  while (true) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      console.error(`❌ Banco indisponível. Nova tentativa em ${retryDelayMs} ms: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
}

// ─── Função auxiliar de query ──────────────────────────────────
const query = (text, params) => pool.query(text, params);

const logDatabaseAccess = async () => {
  const result = await pool.query(`
    SELECT current_database() AS db,
           current_user AS db_user,
           has_schema_privilege(current_user, 'core', 'USAGE') AS core_usage,
           has_table_privilege(current_user, 'core.view_app_colaboradores', 'SELECT') AS colaboradores_select
  `);
  const schemaResult = await pool.query('SHOW search_path');
  const details = result.rows[0];

  console.log('🔎 [DB DEBUG] database:', details.db);
  console.log('🔎 [DB DEBUG] user:', details.db_user);
  console.log('🔎 [DB DEBUG] core USAGE:', details.core_usage);
  console.log('🔎 [DB DEBUG] view SELECT:', details.colaboradores_select);
  console.log('🔎 [DB DEBUG] search_path:', schemaResult.rows[0].search_path);
};

// Exportações
export { pool, query, logDatabaseAccess };
export default { pool, query };