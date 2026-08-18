// services/extractBD.js
const db = require('./db');

class ExtractBD {
    getDateRangeFromPeriod(period) {
        const [year, month] = period.split('-');
        const start = `${year}-${month}-01`;
        const lastDay = new Date(year, month, 0).getDate();
        const end = `${year}-${month}-${lastDay}`;
        return { start, end };
    }

    async getEmitidosCount({ colaborador, equipe, periodo }) {
        const { start, end } = this.getDateRangeFromPeriod(periodo);
        let sql = `
            SELECT COUNT(*) as total
            FROM madm.view_app_emitidos_e_assinados e
            LEFT JOIN core.view_app_colaboradores c ON e.consultor_responsavel_emissao = c.nome
            WHERE e.data_envio BETWEEN $1 AND $2
        `;
        const params = [start, end];
        let paramIndex = 3;

        if (colaborador) {
            sql += ` AND e.consultor_responsavel_emissao = $${paramIndex}`;
            params.push(colaborador);
            paramIndex++;
        }
        if (equipe) {
            sql += ` AND c.nome_equipe = $${paramIndex}`;
            params.push(equipe);
            paramIndex++;
        }

        const result = await db.query(sql, params);
        return parseInt(result.rows[0]?.total || 0);
    }

    async getAssinadosCount({ colaborador, equipe, periodo }) {
        const { start, end } = this.getDateRangeFromPeriod(periodo);
        let sql = `
            SELECT COUNT(*) as total
            FROM madm.view_app_emitidos_e_assinados
            WHERE data_assinatura BETWEEN $1 AND $2 
        `;
        const params = [start, end];
        let paramIndex = 3;

        if (colaborador) {
            sql += ` AND consultor_responsavel_assinatura = $${paramIndex}`;
            params.push(colaborador);
            paramIndex++;
        }
        if (equipe) {
            sql += ` AND equipe_responsavel_assinatura = $${paramIndex}`;
            params.push(equipe);
            paramIndex++;
        }

        const result = await db.query(sql, params);
        return parseInt(result.rows[0]?.total || 0);
    }

    async getGanhosCount({ colaborador, equipe, periodo }) {
        const { start, end } = this.getDateRangeFromPeriod(periodo);
        let sql = `
            SELECT COUNT(*) as total
            FROM madm.view_app_kommo_leads l
            LEFT JOIN core.view_app_colaboradores c ON l.lead_usuario_responsavel = c.nome
            WHERE l.data_ganho BETWEEN $1 AND $2
              AND l.funil_vendas IN ('JURIDICO AUDITORIA DE GANHO', 'AUDITORIA DE GANHO', 'PRO')
              AND l.etapa_lead IN ('Venda ganha', 'AG PROTOCOLO', 'PROTOCOLADO', 'Processo finalizado')
        `;
        const params = [start, end];
        let paramIndex = 3;

        if (colaborador) {
            sql += ` AND l.lead_usuario_responsavel = $${paramIndex}`;
            params.push(colaborador);
            paramIndex++;
        }
        if (equipe) {
            sql += ` AND c.nome_equipe = $${paramIndex}`;
            params.push(equipe);
            paramIndex++;
        }

        const result = await db.query(sql, params);
        return parseInt(result.rows[0]?.total || 0);
    }

    async getPerdidosCount({ colaborador, equipe, periodo }) {
        const { start, end } = this.getDateRangeFromPeriod(periodo);
        let sql = `
            SELECT COUNT(*) as total
            FROM madm.view_app_kommo_leads l
            LEFT JOIN core.view_app_colaboradores c ON l.lead_usuario_responsavel = c.nome
            WHERE l.data_ganho BETWEEN $1 AND $2
              AND l.funil_vendas IN ('JURIDICO AUDITORIA DE GANHO', 'AUDITORIA DE GANHO', 'PRO')
              AND l.etapa_lead = 'Venda perdida'
        `;
        const params = [start, end];
        let paramIndex = 3;

        if (colaborador) {
            sql += ` AND l.lead_usuario_responsavel = $${paramIndex}`;
            params.push(colaborador);
            paramIndex++;
        }
        if (equipe) {
            sql += ` AND c.nome_equipe = $${paramIndex}`;
            params.push(equipe);
            paramIndex++;
        }

        const result = await db.query(sql, params);
        return parseInt(result.rows[0]?.total || 0);
    }

    async getMetrics(options) {
        const { colaborador, equipe, periodo } = options;

        if (!periodo) {
            throw new Error('Período é obrigatório (formato YYYY-MM)');
        }

        const [emitidos, assinados, ganhos, perdidos] = await Promise.all([
            this.getEmitidosCount({ colaborador, equipe, periodo }),
            this.getAssinadosCount({ colaborador, equipe, periodo }),
            this.getGanhosCount({ colaborador, equipe, periodo }),
            this.getPerdidosCount({ colaborador, equipe, periodo })
        ]);

        return {
            emitidos,
            assinados,
            ganhos,
            perdidos,
            periodo,
            ...(colaborador && { colaborador }),
            ...(equipe && { equipe })
        };
    }
}

module.exports = new ExtractBD();