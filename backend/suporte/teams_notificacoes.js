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

    renderTemplate(str, vars) {
        if (typeof str !== 'string' || !str) return str;
        if (!/\$\{\w+\}/.test(str)) return str;
        return str.replace(/\$\{(\w+)\}/g, (_, key) => {
            const v = vars[key];
            return v === undefined || v === null || v === '' ? '—' : String(v);
        });
    }

    montarUrlCoordenador(idTicketMovimentacao) {
        const baseUrl = process.env.APP_PUBLIC_URL ||
            process.env.SUPPORT_PUBLIC_BASE_URL ||
            'https://comissionamento.madmbrasil.com.br';
        const sistemaUrl = new URL('/suporte', baseUrl);
        sistemaUrl.searchParams.set('aba', 'coordenador');
        if (idTicketMovimentacao != null) {
            sistemaUrl.searchParams.set('id', String(idTicketMovimentacao));
        }
        return sistemaUrl.href;
    }

    criarCartaoValidacaoCoordenador(dados, assunto, unidadeId) {
        const valor = (v) => {
            const s = v === undefined || v === null ? '' : String(v).trim();
            return s || 'Não informado';
        };
        const fact = (title, value) => ({ title, value: valor(value) });

        const idCaso = dados.idTicketMovimentacao ?? null;
        const pipeline = dados.pipelineNome || dados.pipeline;
        const stage = dados.stageNome || dados.stage;
        const pipelineEtapa = [pipeline, stage].filter(Boolean).join(' / ');
        const solicitante = dados.solicitante && dados.equipe
            ? `${dados.solicitante} (${dados.equipe})`
            : dados.solicitante || dados.equipe;

        const body = [
            {
                type: 'Container',
                style: 'emphasis',
                bleed: true,
                items: [{
                    type: 'ColumnSet',
                    columns: [
                        {
                            type: 'Column',
                            width: 'stretch',
                            items: [
                                {
                                    type: 'TextBlock',
                                    text: 'Movimentação aguardando validação',
                                    weight: 'Bolder',
                                    size: 'Medium',
                                    wrap: true,
                                },
                                {
                                    type: 'TextBlock',
                                    text: `Ticket de movimentação #${valor(idCaso)} — requer decisão do coordenador`,
                                    isSubtle: true,
                                    spacing: 'None',
                                    wrap: true,
                                },
                            ],
                        },
                        {
                            type: 'Column',
                            width: 'auto',
                            items: [{
                                type: 'TextBlock',
                                text: 'BLOQUEADO',
                                color: 'Attention',
                                weight: 'Bolder',
                                size: 'Small',
                                horizontalAlignment: 'Right',
                            }],
                        },
                    ],
                }],
            },
            {
                type: 'FactSet',
                spacing: 'Medium',
                facts: [
                    fact('Cliente', dados.cliente),
                    fact('Telefone', dados.telefone),
                    fact('Equipe destino', dados.equipeDestino),
                    fact('Assessor destino', dados.assessorDestino),
                    fact('Produto', dados.produto),
                    fact('Pipeline / Etapa', pipelineEtapa),
                    fact('Solicitante', solicitante),
                    fact('Unidade', unidadeId),
                ],
            },
            {
                type: 'TextBlock',
                text: '**Motivo do bloqueio:**',
                spacing: 'Medium',
                wrap: true,
            },
            {
                type: 'TextBlock',
                text: valor(dados.mensagem),
                wrap: true,
                isSubtle: true,
                maxLines: 8,
            },
        ];

        if (dados.notesLastUpdated) {
            body.push({
                type: 'Container',
                spacing: 'Medium',
                items: [{
                    type: 'TextBlock',
                    text: `🕓 Última modificação: ${dados.notesLastUpdated}`,
                    wrap: true,
                    isSubtle: true,
                    size: 'Small',
                }],
            });
        }

        const actions = [{
            type: 'Action.OpenUrl',
            title: '🔗 Validar caso no sistema',
            url: this.montarUrlCoordenador(idCaso),
        }];
        if (dados.link) { 
            actions.push({
                type: 'Action.OpenUrl',
                title: 'Ver card HubSpot',
                url: dados.link,
            });
        }

        return {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            msteams: { width: 'Full' },
            body,
            actions,
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

            const templateVars = {
                cliente: dados.cliente,
                telefone: dados.telefone,
                equipeDestino: dados.equipeDestino,
                assessorDestino: dados.assessorDestino,
                produto: dados.produto,
                pipeline: dados.pipelineNome || dados.pipeline,
                stage: dados.stageNome || dados.stage,
                pipelineNome: dados.pipelineNome || dados.pipeline,
                stageNome: dados.stageNome || dados.stage,
                solicitante: dados.solicitante,
                equipeOrigem: dados.equipe,
                equipe: dados.equipe,
                unidade: dados.unidadeId ?? (casoCoordenador ? unidadeId : null),
                unidadeId: dados.unidadeId ?? (casoCoordenador ? unidadeId : null),
                mensagem: dados.mensagem,
                status: dados.status,
                link: dados.link,
                dealId: dados.dealId,
                notesLastUpdated: dados.notesLastUpdated,
                titulo: dados.titulo,
                idTicketMovimentacao: dados.idTicketMovimentacao,
                idTicket: dados.idTicket,
                assunto,
            };

            const descricaoRenderizada = this.renderTemplate(dados.descricao, templateVars);
            const mensagemRenderizada  = this.renderTemplate(dados.mensagem,  templateVars);

            // Objeto já com os textos renderizados — usado pelos builders
            // de cartão, para que as facts também exibam o resultado certo.
            const dadosRenderizados = {
                ...dados,
                descricao: descricaoRenderizada,
                mensagem: mensagemRenderizada,
            };

            // [CORRIGIDO] Cartão montado no servidor, com valores reais.
            const adaptiveCard = casoCoordenador
                ? this.criarCartaoValidacaoCoordenador(dadosRenderizados, assunto, unidadeId)
                : assunto.toLowerCase().startsWith('movimentacao')
                    ? this.criarCartaoMovimentacao({ ...dadosRenderizados, unidadeId }, assunto)
                    : null;

            // Monta o JSON raiz exatamente como o Power Automate espera
            const payload = {
                titulo: casoCoordenador ? assunto : (dados.titulo || assunto),
                assunto,
                descricao: descricaoRenderizada,
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
                mensagem: mensagemRenderizada || null,
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
                // [CORRIGIDO] Campos que o cartão do coordenador usa e que
                // antes não eram enviados (por isso apareciam como ${...}).
                idTicketMovimentacao: dados.idTicketMovimentacao ?? null,
                idTicket: dados.idTicket ?? null,
                equipeOrigem: dados.equipe || null,
                unidade: casoCoordenador ? unidadeId : (dados.unidadeId || null),
                urlValidacao: casoCoordenador ? this.montarUrlCoordenador(dados.idTicketMovimentacao) : null,
                ...(adaptiveCard
                    ? {
                        adaptiveCard,
                        // Mesmo cartão como texto, para o campo "Adaptive Card"
                        // do Power Automate (que espera uma string JSON).
                        adaptiveCardJson: JSON.stringify(adaptiveCard),
                    }
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