// services/extractBD.js
import { analyticsQuery } from '../backend/services/bd/analyticsSemaphore.js';
import { cacheFirst } from '../backend/services/bd/cacheFirst.js';
// ↑ ajuste os caminhos relativos conforme sua árvore real.
//   O importante: extractBD tem que usar o MESMO analyticsQuery
//   (semáforo + analyticsPool), NÃO o `pool.query` do API geral.

const CACHE_TTL = { ttlMs: 300_000, staleMs: 1_800_000 }; // 5min / 30min
const PRIORITY = 'low'; // não é tela ativa — não compete com dashboard

const FUNIL_IN = `('JURIDICO AUDITORIA DE GANHO', 'AUDITORIA DE GANHO', 'PRO')`;
const ETAPAS_GANHO_IN = `('Venda ganha', 'AG PROTOCOLO', 'PROTOCOLADO', 'Processo finalizado')`;

function getDateRangeFromPeriod(period) {
  const [year, month] = period.split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) {
    throw new Error('Período inválido (formato YYYY-MM)');
  }
  // start = 1º dia do mês, end = último dia (INCLUSIVO, igual ao original)
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

class ExtractBD {
  /**
   * As 4 métricas em UMA query (scalar subqueries).
   * Original: 4 round-trips. Agora: 1.
   * `$1` = start (inclusivo), `$2` = end (inclusivo).
   * `$3` = colaborador (NULL = todos), `$4` = equipe (NULL = todas).
   */
  async getMetricsUncached({ colaborador, equipe, periodo }) {
    const { start, end } = getDateRangeFromPeriod(periodo);
    const sql = `
      SELECT
        (SELECT COUNT(*)
           FROM madm.view_app_emitidos_e_assinados e
           LEFT JOIN core.view_app_colaboradores c
                  ON e.consultor_responsavel_emissao = c.nome
          WHERE e.data_envio BETWEEN $1::date AND $2::date
            AND ($3::text IS NULL OR e.consultor_responsavel_emissao = $3)
            AND ($4::text IS NULL OR c.nome_equipe = $4)
        )::int AS emitidos,

        (SELECT COUNT(*)
           FROM madm.view_app_emitidos_e_assinados
          WHERE data_assinatura BETWEEN $1::date AND $2::date
            AND ($3::text IS NULL OR consultor_responsavel_assinatura = $3)
            AND ($4::text IS NULL OR equipe_responsavel_assinatura = $4)
        )::int AS assinados,

        (SELECT COUNT(*)
           FROM madm.view_app_kommo_leads l
           LEFT JOIN core.view_app_colaboradores c
                  ON l.lead_usuario_responsavel = c.nome
          WHERE l.data_ganho BETWEEN $1::date AND $2::date
            AND l.funil_vendas IN ${FUNIL_IN}
            AND l.etapa_lead IN ${ETAPAS_GANHO_IN}
            AND ($3::text IS NULL OR l.lead_usuario_responsavel = $3)
            AND ($4::text IS NULL OR c.nome_equipe = $4)
        )::int AS ganhos,

        (SELECT COUNT(*)
           FROM madm.view_app_kommo_leads l
           LEFT JOIN core.view_app_colaboradores c
                  ON l.lead_usuario_responsavel = c.nome
          WHERE l.data_ganho BETWEEN $1::date AND $2::date
            AND l.funil_vendas IN ${FUNIL_IN}
            AND l.etapa_lead = 'Venda perdida'
            AND ($3::text IS NULL OR l.lead_usuario_responsavel = $3)
            AND ($4::text IS NULL OR c.nome_equipe = $4)
        )::int AS perdidos
    `;

    const { rows } = await analyticsQuery(
      sql,
      [start, end, colaborador || null, equipe || null],
      PRIORITY,
    );
    const r = rows[0] ?? {};
    return {
      emitidos:  Number(r.emitidos)  || 0,
      assinados: Number(r.assinados) || 0,
      ganhos:    Number(r.ganhos)    || 0,
      perdidos:  Number(r.perdidos)  || 0,
      periodo,
      ...(colaborador && { colaborador }),
      ...(equipe && { equipe }),
    };
  }

  /**
   * Versão pública — cacheFirst + stale-overload + singleflight.
   * Chave determinística por periodo/colaborador/equipe.
   */
  async getMetrics({ colaborador, equipe, periodo } = {}) {
    if (!periodo) {
      throw new Error('Período é obrigatório (formato YYYY-MM)');
    }
    const key = `extract:metrics:${periodo}:${equipe || 'all'}:${colaborador || 'all'}`;
    return cacheFirst(
      key,
      () => this.getMetricsUncached({ colaborador, equipe, periodo }),
      CACHE_TTL,
    );
  }

  // ── Compat shim: outros arquivos podem ainda chamar os 4 métodos ──────────
  // Cada um agora passa por getMetrics (cache hit) e devolve só o campo.
  // NÃO chamam analyticsQuery direto — economiza round-trips em cascata.
  async getEmitidosCount(opts)  { return (await this.getMetrics(opts)).emitidos;  }
  async getAssinadosCount(opts) { return (await this.getMetrics(opts)).assinados; }
  async getGanhosCount(opts)    { return (await this.getMetrics(opts)).ganhos;    }
  async getPerdidosCount(opts)  { return (await this.getMetrics(opts)).perdidos;  }
}

const instance = new ExtractBD();
export default instance;
export { ExtractBD };