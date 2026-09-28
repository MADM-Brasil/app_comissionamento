import db from './services/db.js';

try {
  const result = await db.query(`
    SELECT UPPER(TRIM(tipo)) AS tipo, COUNT(DISTINCT faixa_min::text || ':' || faixa_max::text || ':' || valor_comissao::text)::int AS faixas
    FROM app_comissionamento.vw_tabela_comissoes
    GROUP BY UPPER(TRIM(tipo))
    ORDER BY tipo
  `);
  console.log(JSON.stringify(result.rows));
} finally {
  await db.pool.end();
}
