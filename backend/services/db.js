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
const pool = new Pool(dbConfig);

// Diagnóstico temporário – ver o que o backend enxerga
pool.on('connect', async (client) => {
  try {
    const dbRes = await client.query('SELECT current_database() AS db');
    const schemaRes = await client.query('SHOW search_path');
    const tablesRes = await client.query(`
      SELECT schemaname, tablename 
      FROM pg_tables 
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schemaname, tablename
    `);
    console.log('🔎 [DB DEBUG] database:', dbRes.rows[0].db);
    console.log('🔎 [DB DEBUG] search_path:', schemaRes.rows[0].search_path);
  } catch (err) {
    console.error('❌ [DB DEBUG] Erro ao obter diagnóstico:', err);
  }
});

pool.on('connect', () => {
  console.log('✅ Conectado ao PostgreSQL com sucesso');
});

pool.on('error', (err) => {
  console.error('❌ Erro inesperado no pool do PostgreSQL:', err);
  process.exit(-1);
});

// ─── Função auxiliar de query ──────────────────────────────────
const query = (text, params) => pool.query(text, params);

// Exportações
export { pool, query };
export default { pool, query };