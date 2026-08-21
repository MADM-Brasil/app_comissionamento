// backend/suporte/teams_notificacoes.js
class TeamsNotificadorSuporte {
    constructor() {
        this.webhooks = {
            casos_discadora: process.env.WEBHOOK_CASOS_DISCADORA || null,
            casos_crm: process.env.WEBHOOK_CASOS_CRM || null,
            casos_bd_dash: process.env.WEBHOOK_CASOS_BD_DASH || null,
            casos_acessos: process.env.WEBHOOK_CASOS_ACESSOS || null,
            outros_casos: process.env.WEBHOOK_OUTROS_CASOS || null,
            casos_suporte: process.env.WEBHOOK_CASOS_SUPORTE || null,
        };

        this.webhookRoteador = process.env.WEBHOOK_ROTEADOR || null;

        Object.entries(this.webhooks).forEach(([key, url]) => {
            if (!url && !this.webhookRoteador) {
                console.warn(`⚠️ WEBHOOK_${key.toUpperCase()} não definido no .env`);
            }
        });
    }

    mapearAssuntoParaChave(assunto) {
        const normalizado = (assunto || '').trim();
        const mapa = {
            'Discadora': 'casos_discadora',
            'CRM': 'casos_crm',
            'Dash': 'casos_bd_dash',
            'Reversao': 'casos_bd_dash',
            'Reversão': 'casos_bd_dash',
            'Acesso': 'casos_acessos',
            'Acessos': 'casos_acessos',
            'Outro': 'outros_casos',
            'Movimentacao': 'casos_suporte',
            'Movimentação': 'casos_suporte',
        };
        return mapa[normalizado] || 'outros_casos';
    }

    formatarDataHora() {
        const agora = new Date();
        return agora.toLocaleString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    }

    async enviar(dados) {
        try {
            if (!dados.assunto) {
                throw new Error('Campo "assunto" é obrigatório');
            }
            if (!dados.descricao || dados.descricao.trim().length < 10) {
                throw new Error('Descrição deve ter pelo menos 10 caracteres');
            }

            let webhookUrl = null;
            let chave = null;

            if (this.webhookRoteador) {
                webhookUrl = this.webhookRoteador;
                chave = 'roteador';
            } else {
                chave = this.mapearAssuntoParaChave(dados.assunto);
                webhookUrl = this.webhooks[chave];
            }

            if (!webhookUrl) {
                throw new Error(
                    `Webhook para o assunto "${dados.assunto}" (chave: ${chave}) não configurado. ` +
                    'Verifique as variáveis de ambiente no .env.'
                );
            }

            // Monta o JSON raiz exatamente como o Power Automate espera
            const payload = {
    titulo: dados.titulo || dados.assunto,
    assunto: dados.assunto,
    descricao: dados.descricao,
    solicitante: dados.solicitante || 'Não informado',
    equipe: dados.equipe || 'Não informada',
    dataHora: this.formatarDataHora(),
    anexosMarkdown: dados.anexosMarkdown || 'Nenhum anexo',
    // Campos extras para movimentação
    cliente: dados.cliente || null,
    telefone: dados.telefone || null,
    equipeDestino: dados.equipeDestino || null,
    assessorDestino: dados.assessorDestino || null,
    status: dados.status || null,
    mensagem: dados.mensagem || null,
    pipeline: dados.pipeline || null, 
    stage: dados.stage || null,
    pipelineNome: dados.pipelineNome || null,
    stageNome: dados.stageNome || null,
};

            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (response.ok) {
                console.log(`✅ Notificação enviada (${dados.assunto})`);
                return { success: true, status: response.status, channel: chave, assunto: dados.assunto };
            } else {
                const errorText = await response.text();
                console.error(`❌ Erro ao enviar (${response.status}):`, errorText);
                return { success: false, status: response.status, error: errorText, channel: chave };
            }
        } catch (error) {
            console.error('❌ Erro no envio da notificação:', error.message);
            return { success: false, error: error.message };
        }
    }
}

export default new TeamsNotificadorSuporte();