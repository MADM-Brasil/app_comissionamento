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

// ─── Listeners ─────────────────────────────────────────────────
// ✅ Correção CRÍTICA: anexa um listener de erro em CADA cliente novo.
// Sem isso, erros emitidos no Client (não no Pool) derrubam o processo.
pool.on('connect', (client) => {
  console.log('✅ Conectado ao PostgreSQL com sucesso');

  client.on('error', (err) => {
    console.error('❌ [DB Client] Erro em cliente PostgreSQL:', err.message);
    // Não relançar — o pool descarta o cliente e cria um novo na próxima query.
  });
});

// Mantido: cobre erros emitidos diretamente pelo Pool (clientes idle).
pool.on('error', (err) => {
  console.error('❌ [DB Pool] Erro inesperado no pool do PostgreSQL:', err.message);
  console.warn('⚠️ O cliente afetado foi descartado. O pool tentará estabelecer uma nova conexão na próxima operação.');
});

pool.on('remove', () => {
  // Log opcional para debug de churn de conexões
  // console.log('🔌 [DB Pool] Cliente removido do pool');
});

// ─── Aguardar banco ficar disponível ───────────────────────────
export async function waitForDatabase({ retryDelayMs = 5000, maxAttempts = Infinity } = {}) {
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      await pool.query('SELECT 1');
      if (attempt > 1) {
        console.log(`✅ Banco disponível após ${attempt} tentativa(s).`);
      }
      return;
    } catch (error) {
      console.error(`❌ Banco indisponível (tentativa ${attempt}). Nova tentativa em ${retryDelayMs} ms: ${error.message}`);
      if (attempt >= maxAttempts) {
        throw new Error(`Banco inacessível após ${attempt} tentativa(s): ${error.message}`);
      }
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

// ─── Encerramento gracioso ─────────────────────────────────────
export async function closePool() {
  try {
    await pool.end();
    console.log('🔌 [DB Pool] Encerrado com sucesso.');
  } catch (err) {
    console.error('❌ [DB Pool] Erro ao encerrar:', err.message);
  }
}

// ─── Exportações ───────────────────────────────────────────────
export { pool, query, logDatabaseAccess };
export default { pool, query };