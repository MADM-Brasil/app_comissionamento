// services/db.js
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

// ─── Configuração da conexão ───────────────────────────────────
const connectionString = process.env.DATABASE_URL;

let dbConfig;
if (connectionString) {
  // Produção (Render) – SSL obrigatório
  dbConfig = {
    connectionString,
    ssl: { rejectUnauthorized: false },
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