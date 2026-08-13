// calculator.js - Sistema de Cálculo de Comissões (Gols, Produtos, Quinquenio, Supervisores e Gaps)

export class Calculator {
    constructor() {
        // Configurações padrão 
        this.config = {
            bonusBase: 10.00,
            comissaoPercentualPadrao: 5,
            bonusExtraPorMeta: 50.00
        };

        // lista de e‑mails dos Supervisores SR
        this.supervisorSREmails = new Set();
    }

    // define os Supervisores SR
    setSupervisorSREmails(emails) {
        this.supervisorSREmails = new Set(emails.map(e => e.trim().toLowerCase()));
    }

    // verifica se um e‑mail é Supervisor SR
    isSupervisorSR(email) {
        return this.supervisorSREmails.has((email || '').trim().toLowerCase());
    }

    // ==================== NOVO: CÁLCULO DE GOLS DIÁRIOS ====================
    /**
     * Calcula gols diários de um assessor.
     * Gol do dia = assinados >= metaGolsAssinados E ganhos >= metaGolsGanhos.
     * @param {Object[]} dailyData - Array de { date, assinados, ganhos }
     * @param {number} metaGolsAssinados
     * @param {number} metaGolsGanhos
     * @returns {{ totalGols: number, dailyGols: Array<{ date, gol: boolean }> }}
     */
    calculateDailyGoals(dailyData, metaGolsAssinados, metaGolsGanhos) {
        let totalGols = 0;
        const dailyGols = dailyData.map(day => {
            const assinados = day.assinados || 0;
            const ganhos = day.ganhos || 0;
            const gol = assinados >= metaGolsAssinados && ganhos >= metaGolsGanhos;
            if (gol) totalGols++;
            return { date: day.date, gol };
        });
        return { totalGols, dailyGols };
    }

    // ==================== TABELA DE FAIXAS ====================
    /**
     * Retorna a faixa atual para um tipo e valor.
     * @param {Object[]} tabelaComissoes - Faixas { tipo, valor_comissao, faixa_min, faixa_max }
     * @param {string} tipo - 'GOL', 'AUXILIO ACIDENTE', etc.
     * @param {number} valor - total de gols ou assinados
     * @returns {Object|null}
     */
    getFaixa(tabelaComissoes, tipo, valor) {
        const faixas = tabelaComissoes.filter(f => f.tipo === tipo);
        for (const faixa of faixas) {
            if (valor >= faixa.faixa_min && valor <= faixa.faixa_max) {
                return faixa;
            }
        }
        return null;
    }

    /**
     * Retorna a próxima faixa superior e o gap.
     * @returns {{ faixa: Object, gap: number }} ou null se for a última faixa.
     */
    getNextFaixa(tabelaComissoes, tipo, valor) {
        const faixas = tabelaComissoes
            .filter(f => f.tipo === tipo)
            .sort((a, b) => a.faixa_min - b.faixa_min);
        const next = faixas.find(f => f.faixa_min > valor);
        if (!next) return null;
        return { faixa: next, gap: next.faixa_min - valor };
    }

    // ==================== CÁLCULO DE COMISSÕES ====================
    calculateGoalCommission(totalGols, tabelaComissoes) {
        const faixa = this.getFaixa(tabelaComissoes, 'GOL', totalGols);
        return faixa ? faixa.valor_comissao : 0;
    }

    calculateProductCommission(totalAssinados, productType, tabelaComissoes) {
        const tipo = productType.toUpperCase();
        const faixa = this.getFaixa(tabelaComissoes, tipo, totalAssinados);
        return faixa ? faixa.valor_comissao : 0;
    }

    calculateQuinquenioCommission(totalAssinados, tabelaComissoes) {
        const faixa = this.getFaixa(tabelaComissoes, 'QUINQUENIO', totalAssinados);
        return faixa ? faixa.valor_comissao : 0;
    }

    calculateSupervisorCommission(totalAssinadosEquipe, isSR, tabelaComissoes) {
        const tipo = isSR ? 'SUPERVISOR SR' : 'SUPERVISOR';
        const faixa = this.getFaixa(tabelaComissoes, tipo, totalAssinadosEquipe);
        return faixa ? faixa.valor_comissao : 0;
    }

    /**
     * Comissão total de um assessor (gols + produto).
     */
    calculateTotalCommission(dailyData, metaGolsAssinados, metaGolsGanhos, totalAssinados, productType, tabelaComissoes) {
        const { totalGols } = this.calculateDailyGoals(dailyData, metaGolsAssinados, metaGolsGanhos);
        const goalCommission = this.calculateGoalCommission(totalGols, tabelaComissoes);
        const productCommission = this.calculateProductCommission(totalAssinados, productType, tabelaComissoes);
        return {
            goalCommission,
            productCommission,
            totalCommission: goalCommission + productCommission,
            totalGols
        };
    }

    // ==================== GAPS PARA PRÓXIMA FAIXA ====================
    /**
     * Gap de gols para a próxima faixa.
     * @returns {{ currentFaixa, nextFaixa, gap, nextValue }} ou null.
     */
    calculateGoalGap(totalGols, tabelaComissoes) {
        const current = this.getFaixa(tabelaComissoes, 'GOL', totalGols);
        const next = this.getNextFaixa(tabelaComissoes, 'GOL', totalGols);
        if (!next) return null;
        return {
            currentFaixa: current,
            nextFaixa: next.faixa,
            gap: next.gap,
            nextValue: next.faixa.faixa_min
        };
    }

    /**
     * Gap de assinados para produto.
     */
    calculateProductGap(totalAssinados, productType, tabelaComissoes) {
        const tipo = productType.toUpperCase();
        const current = this.getFaixa(tabelaComissoes, tipo, totalAssinados);
        const next = this.getNextFaixa(tabelaComissoes, tipo, totalAssinados);
        if (!next) return null;
        return {
            currentFaixa: current,
            nextFaixa: next.faixa,
            gap: next.gap,
            nextValue: next.faixa.faixa_min
        };
    }

    /**
     * Gap para Quinquenio (apenas assinados).
     */
    calculateQuinquenioGap(totalAssinados, tabelaComissoes) {
        return this.calculateProductGap(totalAssinados, 'QUINQUENIO', tabelaComissoes);
    }

    /**
     * Gap para Supervisores (assinados da equipe).
     */
    calculateSupervisorGap(totalAssinadosEquipe, isSR, tabelaComissoes) {
        const tipo = isSR ? 'SUPERVISOR SR' : 'SUPERVISOR';
        const current = this.getFaixa(tabelaComissoes, tipo, totalAssinadosEquipe);
        const next = this.getNextFaixa(tabelaComissoes, tipo, totalAssinadosEquipe);
        if (!next) return null;
        return {
            currentFaixa: current,
            nextFaixa: next.faixa,
            gap: next.gap,
            nextValue: next.faixa.faixa_min
        };
    }

    // ==================== MÉTODOS LEGADOS  ====================
    checkGoal(ganhos, assinados, metaQuantidade = 10, metaPercentual = 70) {
        const score = ganhos * 1 + assinados * 1; // pesos neutros
        const required = metaQuantidade * 1;
        const atingiuQuantidade = score >= required;
        let atingiuPercentual = true;
        if (assinados > 0) {
            atingiuPercentual = (assinados / (ganhos + assinados)) * 100 >= metaPercentual;
        }
        return atingiuQuantidade && atingiuPercentual;
    }

    calculateProgress(ganhos, metaQuantidade = 10) {
        if (metaQuantidade <= 0) return 0;
        return Math.min(100, Math.max(0, (ganhos / metaQuantidade) * 100));
    }

    calculateRemainingToGoal(ganhos, metaQuantidade = 10) {
        return Math.max(0, metaQuantidade - ganhos);
    }

    calculateBonus(metasBatidas, ganhos, metaQuantidade = 10, metaExtra = false) {
        return 0; // Placeholder
    }

    calculateCommission(assinados, percentualComissao = null, valorPorAssinado = 100) {
        return 0; // Placeholder
    }

    calculateTotalScore(ganhos, assinados) {
        return ganhos + assinados;
    }

    calculateSuccessRate(ganhos, assinados) {
        const total = ganhos + assinados;
        return total === 0 ? 0 : (assinados / total) * 100;
    }

    calculateTeamBonus(teamMembers, metaEquipe = null) {
        return { totalBonus: 0, members: [] };
    }

    calculateRanking(members) {
        return members.map((m, i) => ({ ...m, ranking: i + 1, score: 0 }));
    }

    calculateProjection(ganhosAtuais, assinadosAtuais, diasRestantes, metaQuantidade = 10) {
        return {
            ganhosProjetados: ganhosAtuais,
            assinadosProjetados: assinadosAtuais,
            projecaoMeta: false,
            ganhosNecessariosPorDia: 0
        };
    }

    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }

    getConfig() {
        return { ...this.config };
    }
}

export const calculator = new Calculator();