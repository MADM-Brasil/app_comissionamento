// calculator.js - Sistema de Cálculo de Comissões

export class Calculator {
    constructor() {
        this.config = {
            bonusBase: 10.00,
            comissaoPercentualPadrao: 5,
            bonusExtraPorMeta: 50.00
        };
        this.supervisorSREmails = new Set();
    }

    setSupervisorSREmails(emails) {
        this.supervisorSREmails = new Set(emails.map(e => e.trim().toLowerCase()));
    }

    isSupervisorSR(email) {
        return this.supervisorSREmails.has((email || '').trim().toLowerCase());
    }

    // ==================== CÁLCULO DE GOLS DIÁRIOS (ATUALIZADO) ====================
    /**
     * Calcula gols diários de um assessor.
     * Agora conta múltiplos gols por dia: mínimo entre assinados/meta e ganhos/meta.
     * Normaliza a data para YYYY-MM-DD.
     */
    calculateDailyGoals(dailyData, metaGolsAssinados, metaGolsGanhos) {
        let totalGols = 0;
        const dailyGols = dailyData.map(day => {
            const assinados = day.assinados || 0;
            const ganhos = day.ganhos || 0;

            const golsNoDia = Math.min(
                Math.floor(assinados / metaGolsAssinados),
                Math.floor(ganhos / metaGolsGanhos)
            );
            totalGols += golsNoDia;
            return { date: (day.date || '').slice(0, 10), gols: golsNoDia };
        });
        return { totalGols, dailyGols };
    }

    // ==================== APLICAÇÃO DE CAMPANHAS ====================
    /**
     * Aplica campanhas ativas (aprovadas) aos gols diários.
     * Tipos suportados:
     * - GOLS: multiplica os gols do dia pelo multiplicador.
     * - ASSINADOS: adiciona 1 gol por assinado no dia.
     * - PROGRESSIVA: se assinados >= meta mínima (multiplicador), gols = assinados.
     */
    applyCampaignsToDailyGoals(dailyData, metaGolsAssinados, metaGolsGanhos, campanhasAtivas = []) {
        // Normaliza datas dos dados diários
        const normalizedDailyData = dailyData.map(d => ({
            ...d,
            date: (d.date || '').slice(0, 10)
        }));

        const base = this.calculateDailyGoals(normalizedDailyData, metaGolsAssinados, metaGolsGanhos);

        const golsMap = new Map();           // data -> multiplicador máximo
        const assinadosMap = new Map();      // data -> true
        const progressivaMap = new Map();    // data -> meta mínima

        for (const camp of campanhasAtivas) {
            const dateKey = (camp.data_publicacao || '').split('T')[0];
            const tipo = (camp.tipo || '').toUpperCase();

            if (tipo === 'GOLS') {
                const atual = golsMap.get(dateKey) || 0;
                const mult = Number(camp.multiplicador) || 1;
                if (mult > atual) golsMap.set(dateKey, mult);
            } else if (tipo === 'ASSINADOS') {
                assinadosMap.set(dateKey, true);
            } else if (tipo === 'PROGRESSIVA') {
                progressivaMap.set(dateKey, Number(camp.multiplicador) || 0);
            }
        }

        let totalGols = 0;
        const dailyGols = base.dailyGols.map(dayGol => {
            const dateKey = dayGol.date;
            let gols = dayGol.gols;

            // GOLS: multiplicador
            const mult = golsMap.get(dateKey);
            if (mult) gols = gols * mult;

            // ASSINADOS: +1 por assinado
            if (assinadosMap.has(dateKey)) {
                const dayData = normalizedDailyData.find(d => d.date === dateKey);
                if (dayData) gols += (dayData.assinados || 0);
            }

            // PROGRESSIVA: substitui gols
            const metaProgressiva = progressivaMap.get(dateKey);
            if (metaProgressiva !== undefined) {
                const dayData = normalizedDailyData.find(d => d.date === dateKey);
                const assinados = dayData ? (dayData.assinados || 0) : 0;
                gols = (assinados >= metaProgressiva) ? assinados : 0;
            }

            totalGols += gols;
            return { date: dateKey, gols };
        });

        return { totalGols, dailyGols };
    }

    // ==================== TABELA DE FAIXAS ====================
    getFaixa(tabelaComissoes, tipo, valor) {
        const faixas = tabelaComissoes.filter(f => f.tipo === tipo);
        for (const faixa of faixas) {
            if (valor >= faixa.faixa_min && valor <= faixa.faixa_max) {
                return faixa;
            }
        }
        return null;
    }

    getNextFaixa(tabelaComissoes, tipo, valor) {
        const faixas = tabelaComissoes
            .filter(f => f.tipo === tipo)
            .sort((a, b) => a.faixa_min - b.faixa_min);
        const next = faixas.find(f => f.faixa_min > valor);
        if (!next) return null;
        return { faixa: next, gap: next.faixa_min - valor };
    }

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

    calculateTotalCommission(dailyData, metaGolsAssinados, metaGolsGanhos, totalAssinados, productType, tabelaComissoes, campanhasAtivas = []) {
        const { totalGols } = this.applyCampaignsToDailyGoals(dailyData, metaGolsAssinados, metaGolsGanhos, campanhasAtivas);
        const goalCommission = this.calculateGoalCommission(totalGols, tabelaComissoes);
        const productCommission = this.calculateProductCommission(totalAssinados, productType, tabelaComissoes);
        return {
            goalCommission,
            productCommission,
            totalCommission: goalCommission + productCommission,
            totalGols
        };
    }

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

    calculateQuinquenioGap(totalAssinados, tabelaComissoes) {
        return this.calculateProductGap(totalAssinados, 'QUINQUENIO', tabelaComissoes);
    }

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

    // ==================== MÉTODOS LEGADOS ====================
    checkGoal(ganhos, assinados, metaQuantidade = 10, metaPercentual = 70) {
        const score = ganhos * 1 + assinados * 1;
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
        return 0;
    }

    calculateCommission(assinados, percentualComissao = null, valorPorAssinado = 100) {
        return 0;
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