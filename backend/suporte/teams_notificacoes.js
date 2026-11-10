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
            casos_validacao_coordenador: process.env.WEBHOOK_CASOS_VALIDACAO_COORDENADOR || null,
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

    criarCartaoValidacaoCoordenador(dados, assunto, unidadeId) {
        const baseUrl = process.env.APP_PUBLIC_URL ||
            process.env.SUPPORT_PUBLIC_BASE_URL ||
            'https://comissionamento.madmbrasil.com.br';
        const sistemaUrl = new URL('/suporte', baseUrl);
        sistemaUrl.searchParams.set('aba', 'coordenador');
        if (dados.idTicketMovimentacao != null) {
            sistemaUrl.searchParams.set('id', String(dados.idTicketMovimentacao));
        }

        const fact = (title, value) => ({ title, value: String(value || 'Não informado') });
        const actions = [{
            type: 'Action.OpenUrl',
            title: 'Validar caso no sistema',
            url: sistemaUrl.href,
        }];
        if (dados.link) {
            actions.push({
                type: 'Action.OpenUrl',
                title: 'Ver card HubSpot',
                url: dados.link,
            });
        }

        return {
            type: 'AdaptiveCard',
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            version: '1.4',
            body: [
                {
                    type: 'TextBlock',
                    size: 'Medium',
                    weight: 'Bolder',
                    color: 'Attention',
                    text: '📢 VALIDAÇÃO DO COORDENADOR',
                    wrap: true,
                },
                {
                    type: 'TextBlock',
                    text: assunto,
                    weight: 'Bolder',
                    wrap: true,
                },
                {
                    type: 'FactSet',
                    facts: [
                        fact('🆔 Caso', dados.idTicketMovimentacao),
                        fact('🎫 Ticket', dados.idTicket),
                        fact('👤 Cliente', dados.cliente),
                        fact('📱 Telefone', dados.telefone),
                        fact('🏢 Equipe origem', dados.equipe),
                        fact('🏢 Equipe destino', dados.equipeDestino),
                        fact('👨‍💼 Assessor destino', dados.assessorDestino),
                        fact('🧑 Solicitante', dados.solicitante),
                        fact('✉️ E-mail solicitante', dados.solicitanteEmail),
                        fact('📍 Unidade', unidadeId),
                        fact('🎯 Status', 'Bloqueado - aguardando coordenador'),
                        fact('📝 Mensagem', dados.mensagem),
                        fact('🏁 Pipeline', dados.pipelineNome || dados.pipeline),
                        fact('📊 Estágio', dados.stageNome || dados.stage),
                        fact('📦 Produto', dados.produto),
                        fact('🕒 Data/Hora', this.formatarDataHora()),
                        ...(dados.notesLastUpdated
                            ? [fact('🕓 Última modificação', dados.notesLastUpdated)]
                            : []),
                    ],
                },
                {
                    type: 'ActionSet',
                    actions,
                },
            ],
        };
    }

    criarCartaoMovimentacao(dados, assunto) {
        const fact = (title, value) => ({
            title,
            value: String(value || 'Não informado'),
        });
        const solicitanteEquipe = dados.solicitante && dados.equipe
            ? `${dados.solicitante} (${dados.equipe})`
            : dados.solicitante || dados.equipe;
        const facts = [
            fact('👤 Cliente', dados.cliente),
            fact('📱 Telefone', dados.telefone),
            fact('🏢 Equipe destino', dados.equipeDestino),
            fact('👨‍💼 Assessor destino', dados.assessorDestino),
            fact('📦 Produto', dados.produto),
            fact('🏁 Pipeline / Etapa', [
                dados.pipelineNome || dados.pipeline,
                dados.stageNome || dados.stage,
            ].filter(Boolean).join(' / ')),
            fact('🧑 Solicitante (equipe de origem)', solicitanteEquipe),
            fact('📍 Unidade', dados.unidadeId),
            fact('🎯 Status', dados.status),
        ];

        if (dados.mensagem) {
            facts.push(fact('📝 Motivo do bloqueio', dados.mensagem));
        }
        if (dados.notesLastUpdated) {
            facts.push(fact('🕓 Última modificação', dados.notesLastUpdated));
        }

        const actions = dados.link
            ? [{
                type: 'Action.OpenUrl',
                title: 'Ver card HubSpot',
                url: dados.link,
            }]
            : [];
        const body = [
            {
                type: 'TextBlock',
                size: 'Medium',
                weight: 'Bolder',
                text: dados.titulo || assunto,
                wrap: true,
            },
            {
                type: 'FactSet',
                facts,
            },
        ];

        if (actions.length) {
            body.push({
                type: 'ActionSet',
                actions,
            });
        }

        return {
            type: 'AdaptiveCard',
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            version: '1.4',
            body,
        };
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
            let assunto = String(dados.assunto).trim();
            const assuntoValidacao = assunto.match(/^Validacao_unidade_([1-5])$/i);
            const statusCoordenador = String(dados.status || '').trim().toLowerCase() === 'coordenador';
            const unidadeId = Number(dados.unidadeId ?? assuntoValidacao?.[1]);
            const casoCoordenador = statusCoordenador || Boolean(assuntoValidacao);

            if (casoCoordenador) {
                if (!Number.isInteger(unidadeId) || unidadeId < 1 || unidadeId > 5) {
                    throw new Error('Unidade do solicitante ausente ou inválida para validação do coordenador.');
                }
                assunto = `Validacao_unidade_${unidadeId}`;
                webhookUrl = this.webhooks.casos_validacao_coordenador;
                chave = 'casos_validacao_coordenador';
            } else if (this.webhookRoteador) {
                webhookUrl = this.webhookRoteador;
                chave = 'roteador';
            } else {
                chave = this.mapearAssuntoParaChave(assunto);
                webhookUrl = this.webhooks[chave];
            }

            if (!webhookUrl) {
                throw new Error(
                    `Webhook para o assunto "${assunto}" (chave: ${chave}) não configurado. ` +
                    'Verifique as variáveis de ambiente no .env.'
                );
            }

            // Monta o JSON raiz exatamente como o Power Automate espera
            const payload = {
    titulo: casoCoordenador ? assunto : (dados.titulo || assunto),
    assunto,
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
    solicitanteEmail: dados.solicitanteEmail || null,
    mensagem: dados.mensagem || null,
    pipeline: dados.pipeline || null, 
    stage: dados.stage || null,
    pipelineNome: dados.pipelineNome || null,
    stageNome: dados.stageNome || null,
    unidadeId: casoCoordenador ? unidadeId : (dados.unidadeId || null),
    dealId: dados.dealId || null,
    link: dados.link || null,
    produto: dados.produto || null,
    regra: dados.regra || null,
    notesLastUpdated: dados.notesLastUpdated || null,
    ...(casoCoordenador
        ? { adaptiveCard: this.criarCartaoValidacaoCoordenador(dados, assunto, unidadeId) }
        : assunto.toLowerCase().startsWith('movimentacao')
            ? { adaptiveCard: this.criarCartaoMovimentacao({ ...dados, unidadeId }, assunto) }
            : {}),
};

            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (response.ok) {
                console.log(`✅ Notificação enviada (${assunto})`);
                return { success: true, status: response.status, channel: chave, assunto };
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