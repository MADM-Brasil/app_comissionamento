// main.js - Sistema MADM Comissionamento 

import { Calculator } from './calculator.js';
import { ExtractBD } from './services/extractBD.js';
import twoFactorService from './security/verif-2factory.js';
import { accessControl } from './services/access-control.js';

// ─── POOL E SESSION STORE (substituem o antigo PostgresService) ───
import { pool } from './services/db.js';
import { PostgreSqlSessionStore } from './PostgreSqlSessionStore.js';

import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3008;

// ─── CONFIGURAÇÃO DA SESSÃO NO POSTGRESQL ───
const sessionStore = new PostgreSqlSessionStore(pool);

app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || 'chave-secreta-sessao',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  }
}));

// ─── MIDDLEWARES PADRÃO ───
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ─── ESTADO GLOBAL DA APLICAÇÃO ───
let currentUser = null;
let selectedDate = new Date().toISOString().split('T')[0];
let twoFactorTimer = null;
let currentConfig = null;
let isAuthenticated = false;

// Elementos DOM (mantidos como no original)
const elements = {
    loginPanel: document.getElementById('loginPanel'),
    twoFactorVerifyPanel: document.getElementById('twoFactorVerifyPanel'),
    overlay: document.getElementById('overlay'),
    userInfoNome: document.getElementById('userInfoNome'),
    userInfoEquipe: document.getElementById('userInfoEquipe'),
    userInfoGrupo: document.getElementById('userInfoGrupo'),
    userAccessLevel: document.getElementById('userAccessLevel'),
    metaValue: document.getElementById('metaValue'),
    bonusValue: document.getElementById('bonusValue'),
    comissaoValue: document.getElementById('comissaoValue'),
    metaProgress: document.getElementById('metaProgress'),
    metaPercent: document.getElementById('metaPercent'),
    QTDAtMeta: document.getElementById('QTD-At-meta'),
    emitidosValue: document.getElementById('emitidosValue'),
    assinadosValue: document.getElementById('assinadosValue'),
    ganhosValue: document.getElementById('ganhosValue'),
    perdidosValue: document.getElementById('perdidosValue'),
    consultaDataMeta: document.getElementById('consultaDataMeta'),
    aplicarDataMetaBtn: document.getElementById('aplicarDataMetaBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    closeLoginBtn: document.getElementById('closeLoginBtn'),
    closeVerifyBtn: document.getElementById('closeVerifyBtn'),
    verifyTwoFactorBtn: document.getElementById('verifyTwoFactorBtn'),
    cancelTwoFactorBtn: document.getElementById('cancelTwoFactorBtn'),
    resendCodeBtn: document.getElementById('resendCodeBtn'),
    tabelaColaboradoresBody: document.getElementById('tabelaColaboradoresBody'),
    totalColaboradores: document.getElementById('totalColaboradores'),
    totalComissoes: document.getElementById('totalComissoes'),
    exportarBtn: document.getElementById('exportarBtn'),
    atualizarBtn: document.getElementById('atualizarBtn'),
    linkEquipes: document.getElementById('linkEquipes'),
    linkIndex: document.getElementById('link-index'),
    mainContent: document.querySelector('main'),
    dashboardContainer: document.querySelector('.dashboard-container'),
    headerContent: document.querySelector('header')
};

// ==================== ROTAS DA API ====================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// NOVA ROTA: Tabela de Comissões (vw_tabela_comissoes)
app.get('/api/tabela-comissoes', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tipo, valor_comissao, faixa_min, faixa_max, data_atualizacao
       FROM app_comissionamento.vw_tabela_comissoes
       ORDER BY tipo, faixa_min`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('Erro ao buscar tabela de comissões:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== INICIALIZAÇÃO ====================

async function startServer() {
  try {
    await pool.query('SELECT 1');
    console.log('✅ Conectado ao PostgreSQL');
    app.listen(PORT, () => {
      console.log(`🚀 Servidor rodando na porta ${PORT}`);
    });
  } catch (error) {
    console.error('❌ Erro ao conectar ao banco:', error);
    process.exit(1);
  }
}

startServer();

export { app, pool };

// ==================== FUNÇÕES DE UTILITÁRIO ====================

function formatCurrency(value) {
    return new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL'
    }).format(value);
}

function formatDate(date) {
    return date.toLocaleDateString('pt-BR');
}

function parseDate(dateString) {
    const parts = dateString.split('/');
    if (parts.length === 3) {
        return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    }
    return null;
}

function showOverlay(show) {
    if (elements.overlay) {
        elements.overlay.style.display = show ? 'block' : 'none';
    }
}

function showPanel(panel, show) {
    if (panel) {
        panel.style.display = show ? 'block' : 'none';
        showOverlay(show);
    }
}

function toggleMainContent(show) {
    if (elements.mainContent) {
        elements.mainContent.style.display = show ? 'block' : 'none';
    }
    if (elements.headerContent) {
        elements.headerContent.style.display = show ? 'flex' : 'none';
    }
}

// ==================== FUNÇÕES DE CONFIGURAÇÃO ====================

async function loadUserConfigurations(userId) {
    try {
        // Configurações permanecem na tabela original (sem view)
        const res = await pool.query(
            'SELECT * FROM app_comissionamento.configuracoes_usuario WHERE usuario_id = $1',
            [userId]
        );
        const userConfig = res.rows[0];

        if (userConfig) {
            calculator.updateConfig({
                pesoGanhos: userConfig.peso_ganhos || 3,
                pesoAssinados: userConfig.peso_assinados || 3,
                bonusBase: userConfig.bonus_base || 10.00,
                comissaoPercentualPadrao: userConfig.comissao_percentual_padrao || 5,
                bonusExtraPorMeta: userConfig.bonus_extra_por_meta || 50.00
            });
            currentConfig = calculator.getConfig();
        } else {
            currentConfig = calculator.getConfig();
        }
        return currentConfig;
    } catch (error) {
        console.error('Erro ao carregar configurações:', error);
        currentConfig = calculator.getConfig();
        return currentConfig;
    }
}

function applyAccessRestrictions() {
    if (!currentUser) return;

    const uiConfig = accessControl.getUIConfig(currentUser);

    if (elements.linkEquipes) {
        elements.linkEquipes.style.display = uiConfig.showTeamPage ? 'inline-block' : 'none';
    }
    if (elements.exportarBtn) {
        elements.exportarBtn.style.display = uiConfig.showExportButton ? 'inline-block' : 'none';
    }
    if (elements.userAccessLevel) {
        elements.userAccessLevel.textContent = uiConfig.accessLevel;
        elements.userAccessLevel.title = `Grupo: ${uiConfig.group}`;
    }
    if (elements.userInfoGrupo) {
        elements.userInfoGrupo.textContent = currentUser.cargo || 'N/A';
    }
}

// ==================== FUNÇÕES DE AUTENTICAÇÃO ====================

async function handleLogin(event) {
    event.preventDefault();

    const email = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    const statusDiv = document.getElementById('loginStatus');
    if (statusDiv) {
        statusDiv.textContent = '';
        statusDiv.className = 'login-status';
    }

    try {
        const userRes = await pool.query(
            `SELECT email, nome, nome_equipe, cargo, status, periodo
             FROM core.view_app_colaboradores
             WHERE email = $1`,
            [email]
        );
        if (userRes.rows.length === 0) {
            showLoginStatus('Usuário ou senha inválidos', 'error');
            return;
        }
        const user = userRes.rows[0];

        const accessLevel = accessControl.getAccessLevel(user.cargo);
        if (accessLevel === 0) {
            showLoginStatus('Acesso negado. Usuário sem permissão.', 'error');
            return;
        }

        const twoFactorResult = await twoFactorService.sendCode(user.email, user.nome);
        if (!twoFactorResult.success) {
            showLoginStatus(twoFactorResult.error || 'Erro ao enviar código', 'error');
            return;
        }

        req.session.userId = user.email;
        req.session.tempToken = twoFactorResult.tempToken;
        req.session.ip = req.ip;
        req.session.userAgent = req.headers['user-agent'];

        req.session.save((err) => {
            if (err) {
                showLoginStatus('Erro interno', 'error');
                return;
            }

            currentUser = {
                id: user.email,
                nome: user.nome,
                email: user.email,
                equipe: user.nome_equipe,
                cargo: user.cargo,
                status: user.status,
                periodo: user.periodo
            };
            showPanel(elements.loginPanel, false);
            showPanel(elements.twoFactorVerifyPanel, true);
            startTwoFactorTimer();
            document.getElementById('twoFactorCode').value = '';
        });

    } catch (error) {
        console.error('Erro no login:', error);
        showLoginStatus('Erro ao realizar login', 'error');
    }
}

function showLoginStatus(message, type) {
    const statusDiv = document.getElementById('loginStatus');
    if (statusDiv) {
        statusDiv.textContent = message;
        statusDiv.className = `login-status ${type}`;
        setTimeout(() => {
            statusDiv.textContent = '';
            statusDiv.className = 'login-status';
        }, 3000);
    }
}

function startTwoFactorTimer() {
    if (twoFactorTimer) clearInterval(twoFactorTimer);

    let timeLeft = 300;
    const timerElement = document.createElement('div');
    timerElement.id = 'twoFactorTimer';
    timerElement.className = 'timer-countdown';

    const verifyPanel = document.querySelector('.twofactor-content');
    if (verifyPanel) {
        const existingTimer = document.getElementById('twoFactorTimer');
        if (existingTimer) existingTimer.remove();
        verifyPanel.appendChild(timerElement);
    }

    twoFactorTimer = setInterval(() => {
        const minutes = Math.floor(timeLeft / 60);
        const seconds = timeLeft % 60;
        timerElement.textContent = `Código expira em: ${minutes}:${seconds.toString().padStart(2, '0')}`;

        if (timeLeft <= 0) {
            clearInterval(twoFactorTimer);
            timerElement.textContent = 'Código expirado. Solicite um novo.';
            timerElement.style.color = 'red';
        }
        timeLeft--;
    }, 1000);
}

async function verifyTwoFactor() {
    const enteredCode = document.getElementById('twoFactorCode').value;
    const userId = currentUser?.id;

    if (!userId) {
        alert('Erro: usuário não identificado');
        return;
    }

    const verification = twoFactorService.verifyCode(userId, enteredCode);
    if (verification.success) {
        clearInterval(twoFactorTimer);
        twoFactorService.stopTimer();
        showPanel(elements.twoFactorVerifyPanel, false);

        isAuthenticated = true;
        toggleMainContent(true);

        await loadUserConfigurations(userId);
        await loadUserDashboard();
        applyAccessRestrictions();
    } else {
        alert(verification.error);
        if (verification.error.includes('Muitas tentativas')) {
            cancelTwoFactor();
        }
    }
}

async function resendTwoFactorCode() {
    const userId = currentUser?.id;
    const userEmail = currentUser?.email;

    if (userId && userEmail) {
        const result = await twoFactorService.resendCode(userId, userEmail);
        if (result.success) {
            alert('Novo código enviado para seu email');
            clearInterval(twoFactorTimer);
            startTwoFactorTimer();
        } else {
            alert(result.error || 'Erro ao reenviar código');
        }
    } else {
        alert('Erro: usuário não identificado');
    }
}

function cancelTwoFactor() {
    clearInterval(twoFactorTimer);
    twoFactorService.stopTimer();

    if (currentUser) {
        twoFactorService.clearCode(currentUser.id);
    }

    showPanel(elements.twoFactorVerifyPanel, false);
    showPanel(elements.loginPanel, true);
    currentUser = null;
    isAuthenticated = false;
    toggleMainContent(false);
}

// ==================== CONTROLE DE ACESSO ÀS PÁGINAS ====================

function checkPageAccess() {
    if (!isAuthenticated || !currentUser) {
        if (window.location.pathname.includes('equipes.html')) {
            window.location.href = '../index.html';
        }
        return;
    }

    const currentPath = window.location.pathname;
    const userLevel = accessControl.getAccessLevel(currentUser.cargo);

    if (currentPath.includes('equipes.html')) {
        if (userLevel === 1) {
            showAccessDeniedMessage('Acesso Negado', 'Usuários do tipo ASSESSOR não têm permissão para acessar a página de equipes.');
            setTimeout(() => { window.location.href = '../index.html'; }, 3000);
            return;
        }

        const permissions = accessControl.getUserPermissions(currentUser);
        if (!permissions.canViewTeam) {
            showAccessDeniedMessage('Acesso Negado', 'Você não tem permissão para visualizar dados da equipe.');
            setTimeout(() => { window.location.href = '../index.html'; }, 3000);
            return;
        }

        loadTeamMembers();
    }
}

function showAccessDeniedMessage(title, message) {
    const modal = document.createElement('div');
    modal.className = 'access-denied-modal';
    modal.innerHTML = `
        <div class="access-denied-content">
            <div class="access-denied-header">
                <span class="access-denied-icon">🚫</span>
                <h2>${title}</h2>
            </div>
            <div class="access-denied-body">
                <p>${message}</p>
                <p>Redirecionando para o dashboard em alguns segundos...</p>
            </div>
            <div class="access-denied-footer">
                <button onclick="window.location.href='../index.html'" class="btn-primary">Voltar ao Dashboard</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

// ==================== FUNÇÕES DO DASHBOARD ====================

async function loadUserDashboard() {
    if (!currentUser || !isAuthenticated) return;

    try {
        // Emitidos – view_app_emitidos_e_assinados
        const emitidosRes = await pool.query(
            `SELECT COUNT(*)::int AS total
             FROM madm.view_app_emitidos_e_assinados
             WHERE consultor_responsavel_emissao = $1
               AND data_envio::date = $2`,
            [currentUser.nome, selectedDate]
        );
        const emitidos = emitidosRes.rows[0].total;

        // Assinados – view_app_emitidos_e_assinados com status 'signed'
        const assinadosRes = await pool.query(
            `SELECT COUNT(*)::int AS total
             FROM madm.view_app_emitidos_e_assinados
             WHERE consultor_responsavel_assinatura = $1
               AND data_assinatura::date = $2
               AND status = 'signed'`,
            [currentUser.nome, selectedDate]
        );
        const assinados = assinadosRes.rows[0].total;

        // Ganhos – view_app_kommo_leads com filtros de funil e etapas
        const ganhosRes = await pool.query(
            `SELECT COUNT(*)::int AS total
             FROM madm.view_app_kommo_leads
             WHERE lead_usuario_responsavel = $1
               AND data_ganho::date = $2
               AND funil_vendas = ANY($3)
               AND etapa_lead = ANY($4)`,
            [currentUser.nome, selectedDate,
             ['AUDITORIA DE GANHO', 'JURIDICO AUDITORIA DE GANHO', 'NOVO - AUDITORIA DE GANHO', 'PRO'],
             ['Venda ganha', 'PROTOCOLADO', 'AG PROTOCOLO', 'ANALISE DE PRONTUÁRIO', 'ENTRADA', 'E-MAIL NÃO RESPONDIDO', 'E-MAIL RESPONDIDO', 'AÇÃO DO CLIENTE', 'ASSINATURA DO ADV', 'AG PRONTUÁRIO', 'PENDÊNCIA PRO', 'VALIDAÇÃO SUPERVISOR', 'protocolado']
            ]
        );
        const ganhos = ganhosRes.rows[0].total;

        // Perdidos
        const perdidosRes = await pool.query(
            `SELECT COUNT(*)::int AS total
             FROM madm.view_app_kommo_leads
             WHERE lead_usuario_responsavel = $1
               AND data_ganho::date = $2
               AND funil_vendas = ANY($3)
               AND etapa_lead = 'Venda perdida'`,
            [currentUser.nome, selectedDate,
             ['AUDITORIA DE GANHO', 'JURIDICO AUDITORIA DE GANHO', 'NOVO - AUDITORIA DE GANHO', 'PRO']
            ]
        );
        const perdidos = perdidosRes.rows[0].total;

        if (elements.emitidosValue) elements.emitidosValue.textContent = emitidos;
        if (elements.assinadosValue) elements.assinadosValue.textContent = assinados;
        if (elements.ganhosValue) elements.ganhosValue.textContent = ganhos;
        if (elements.perdidosValue) elements.perdidosValue.textContent = perdidos;

        // Meta – sem view fornecida, mantém tabela original
        const metaRes = await pool.query(
            'SELECT * FROM app_comissionamento.metas WHERE usuario_id = $1',
            [currentUser.id]
        );
        const metaConfig = metaRes.rows[0] || {};
        const metaQuantidade = metaConfig.meta_quantidade || 10;
        const metaPercentual = metaConfig.meta_percentual || 70;

        const bateuMeta = calculator.checkGoal(ganhos, assinados, metaQuantidade, metaPercentual);
        const metasBatidas = bateuMeta ? 1 : 0;

        if (elements.metaValue) elements.metaValue.textContent = metasBatidas;

        const progressPercent = calculator.calculateProgress(ganhos, metaQuantidade);
        if (elements.metaProgress) elements.metaProgress.style.width = `${Math.min(100, progressPercent)}%`;
        if (elements.metaPercent) elements.metaPercent.textContent = `${Math.round(progressPercent)}%`;

        const qtdParaMeta = calculator.calculateRemainingToGoal(ganhos, metaQuantidade);
        if (elements.QTDAtMeta) elements.QTDAtMeta.textContent = Math.max(0, qtdParaMeta);

        // Comissão – usando configuração padrão (view de métricas assessores não tem campo comissao_colaborador)
        const comissaoPercentual = currentConfig?.comissaoPercentualPadrao || 5;
        const comissao = calculator.calculateCommission(assinados, comissaoPercentual);
        const bonus = calculator.calculateBonus(metasBatidas, ganhos, metaQuantidade);

        if (elements.comissaoValue) elements.comissaoValue.textContent = formatCurrency(comissao);
        if (elements.bonusValue) elements.bonusValue.textContent = formatCurrency(bonus);

        const totalScore = calculator.calculateTotalScore(ganhos, assinados);
        const successRate = calculator.calculateSuccessRate(ganhos, assinados);
        updateExtraMetrics(totalScore, successRate, bateuMeta);

        // Extração (agora usando as views)
        await extractBD.extractUserData(currentUser.id, selectedDate);

        // Buscar metas de gols (novos campos)
        try {
            const mesAtual = selectedDate.substring(0, 7);
            const golsRes = await pool.query(
                `SELECT meta_gols_assinados, meta_gols_ganhos
                 FROM app_comissionamento.view_app_metricas_assessores
                 WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))
                   AND TO_CHAR(data_metrica::date, 'YYYY-MM') = $2`,
                [currentUser.email, mesAtual]
            );
            if (golsRes.rows.length > 0) {
                const golsData = golsRes.rows[0];
                // Exibir nos elementos correspondentes (se existirem)
                const golsAssElem = document.getElementById('metaGolsAssinados');
                const golsGanElem = document.getElementById('metaGolsGanhos');
                if (golsAssElem) golsAssElem.textContent = golsData.meta_gols_assinados || 0;
                if (golsGanElem) golsGanElem.textContent = golsData.meta_gols_ganhos || 0;
            }
        } catch (golsErr) {
            console.warn('Metas de gols não disponíveis:', golsErr.message);
        }

    } catch (error) {
        console.error('Erro ao carregar dashboard:', error);
        alert('Erro ao carregar dados do dashboard. Tente novamente.');
    }
}

function updateExtraMetrics(totalScore, successRate, bateuMeta) {
    let scoreElement = document.getElementById('totalScore');
    let rateElement = document.getElementById('successRate');
    let metaStatusElement = document.getElementById('metaStatus');

    if (!scoreElement) {
        const metricsSection = document.querySelector('.metrics-cards');
        if (metricsSection) {
            const scoreCard = document.createElement('div');
            scoreCard.className = 'card';
            scoreCard.innerHTML = `<h3>Pontuação Total</h3><div class="card-value" id="totalScore">${totalScore}</div>`;
            metricsSection.appendChild(scoreCard);

            const rateCard = document.createElement('div');
            rateCard.className = 'card';
            rateCard.innerHTML = `<h3>Aproveitamento</h3><div class="card-value" id="successRate">${Math.round(successRate)}%</div>`;
            metricsSection.appendChild(rateCard);
        }
    } else {
        if (scoreElement) scoreElement.textContent = totalScore;
        if (rateElement) rateElement.textContent = `${Math.round(successRate)}%`;
    }

    const metaCard = document.querySelector('.indicator-card:first-child');
    if (metaCard && !metaStatusElement) {
        const statusDiv = document.createElement('div');
        statusDiv.id = 'metaStatus';
        statusDiv.className = 'meta-status';
        statusDiv.style.marginTop = '10px';
        statusDiv.style.fontWeight = 'bold';
        metaCard.appendChild(statusDiv);
        metaStatusElement = statusDiv;
    }

    if (metaStatusElement) {
        metaStatusElement.textContent = bateuMeta ? '✅ Meta BATIDA!' : '⏳ Em progresso...';
        metaStatusElement.style.color = bateuMeta ? 'green' : 'orange';
    }
}

// ==================== FUNÇÕES DA PÁGINA DE EQUIPE ====================

async function loadTeamMembers() {
    if (!currentUser || !isAuthenticated) return;

    const permissions = accessControl.getUserPermissions(currentUser);
    if (!permissions.canViewTeam) return;

    try {
        const teamRes = await pool.query(
            `SELECT email, nome, nome_equipe, cargo, status, periodo
             FROM core.view_app_colaboradores
             WHERE nome_equipe = $1 AND LOWER(status) = 'ativo'`,
            [currentUser.equipe]
        );
        const teamMembers = teamRes.rows.map(m => ({
            id: m.email,
            nome: m.nome,
            equipe: m.nome_equipe,
            cargo: m.cargo,
            status: m.status,
            periodo: m.periodo
        }));

        const filteredMembers = accessControl.filterTeamData(teamMembers, currentUser);
        const rankedMembers = calculator.calculateRanking(filteredMembers);
        renderTeamTable(rankedMembers);

        const teamBonus = calculator.calculateTeamBonus(filteredMembers);
        displayTeamBonus(teamBonus);
    } catch (error) {
        console.error('Erro ao carregar equipe:', error);
    }
}

function renderTeamTable(members) {
    if (!elements.tabelaColaboradoresBody) return;

    const tbody = elements.tabelaColaboradoresBody;
    tbody.innerHTML = '';

    let totalComissao = 0;
    let totalBonus = 0;

    members.forEach(member => {
        const row = tbody.insertRow();
        row.insertCell(0).textContent = `#${member.ranking}`;
        row.insertCell(1).textContent = member.id;
        row.insertCell(2).textContent = member.nome;
        row.insertCell(3).textContent = member.equipe;
        row.insertCell(4).textContent = member.cargo;
        row.insertCell(5).textContent = member.status;
        row.insertCell(6).textContent = member.meta_individual || 0;

        const comissao = member.comissao;
        const bonus = member.bonus;
        row.insertCell(7).textContent = formatCurrency(comissao);
        row.insertCell(8).textContent = formatCurrency(bonus);
        totalComissao += comissao;
        totalBonus += bonus;

        const statusCell = row.insertCell(9);
        statusCell.textContent = member.bateuMeta ? '✅' : '⏳';
        statusCell.className = member.bateuMeta ? 'meta-achieved' : 'meta-progress';

        row.insertCell(10).textContent = member.ultima_atualizacao ? formatDate(new Date(member.ultima_atualizacao)) : '-';
        row.insertCell(11).textContent = member.score;
    });

    if (elements.totalColaboradores) {
        elements.totalColaboradores.textContent = members.length;
    }
    if (elements.totalComissoes) {
        elements.totalComissoes.textContent = formatCurrency(totalComissao);
    }
}

function displayTeamBonus(teamBonus) {
    let teamBonusElement = document.getElementById('teamBonusInfo');
    if (!teamBonusElement) {
        const container = document.querySelector('.indicators-grid');
        if (container) {
            const bonusCard = document.createElement('div');
            bonusCard.className = 'indicator-card';
            bonusCard.id = 'teamBonusInfo';
            bonusCard.innerHTML = `
                <h4>Bônus da Equipe</h4>
                <div class="indicator-value">${formatCurrency(teamBonus.totalBonus)}</div>
                <small>${teamBonus.members.filter(m => m.bateuMeta).length} membros bateram meta</small>
            `;
            container.appendChild(bonusCard);
            teamBonusElement = bonusCard;
        }
    } else {
        teamBonusElement.querySelector('.indicator-value').textContent = formatCurrency(teamBonus.totalBonus);
        const metaCount = teamBonus.members.filter(m => m.bateuMeta).length;
        teamBonusElement.querySelector('small').textContent = `${metaCount} membros bateram meta`;
    }
}

async function viewUserDetails(userId) {
    if (!accessControl.canViewUser(currentUser, { id: userId })) {
        alert('Você não tem permissão para visualizar dados deste usuário.');
        return;
    }

    const colabRes = await pool.query(
        `SELECT nome FROM core.view_app_colaboradores WHERE email = $1`,
        [userId]
    );
    if (colabRes.rows.length === 0) return alert('Colaborador não encontrado.');
    const nomeColab = colabRes.rows[0].nome;

    const emitidosRes = await pool.query(
        `SELECT COUNT(*)::int AS total FROM madm.view_app_emitidos_e_assinados WHERE consultor_responsavel_emissao = $1 AND data_envio::date = $2`,
        [nomeColab, selectedDate]
    );
    const assinadosRes = await pool.query(
        `SELECT COUNT(*)::int AS total FROM madm.view_app_emitidos_e_assinados WHERE consultor_responsavel_assinatura = $1 AND data_assinatura::date = $2 AND status = 'signed'`,
        [nomeColab, selectedDate]
    );
    const ganhosRes = await pool.query(
        `SELECT COUNT(*)::int AS total FROM madm.view_app_kommo_leads WHERE lead_usuario_responsavel = $1 AND data_ganho::date = $2 AND funil_vendas = ANY($3) AND etapa_lead = ANY($4)`,
        [nomeColab, selectedDate,
         ['AUDITORIA DE GANHO','JURIDICO AUDITORIA DE GANHO','NOVO - AUDITORIA DE GANHO','PRO'],
         ['Venda ganha','PROTOCOLADO','AG PROTOCOLO','ANALISE DE PRONTUÁRIO','ENTRADA','E-MAIL NÃO RESPONDIDO','E-MAIL RESPONDIDO','AÇÃO DO CLIENTE','ASSINATURA DO ADV','AG PRONTUÁRIO','PENDÊNCIA PRO','VALIDAÇÃO SUPERVISOR','protocolado']
        ]
    );
    const perdidosRes = await pool.query(
        `SELECT COUNT(*)::int AS total FROM madm.view_app_kommo_leads WHERE lead_usuario_responsavel = $1 AND data_ganho::date = $2 AND funil_vendas = ANY($3) AND etapa_lead = 'Venda perdida'`,
        [nomeColab, selectedDate,
         ['AUDITORIA DE GANHO','JURIDICO AUDITORIA DE GANHO','NOVO - AUDITORIA DE GANHO','PRO']
        ]
    );

    const emitidos = emitidosRes.rows[0].total;
    const assinados = assinadosRes.rows[0].total;
    const ganhos = ganhosRes.rows[0].total;
    const perdidos = perdidosRes.rows[0].total;

    const metaRes = await pool.query('SELECT * FROM app_comissionamento.metas WHERE usuario_id = $1', [userId]);
    const metaConfig = metaRes.rows[0] || {};
    const metaQuantidade = metaConfig.meta_quantidade || 10;
    const diasRestantes = 30 - new Date(selectedDate).getDate();
    const projection = calculator.calculateProjection(ganhos, assinados, diasRestantes, metaQuantidade);

    alert(`Detalhes do colaborador:
    
📊 Métricas:
• Emitidos: ${emitidos}
• Assinados: ${assinados}
• Ganhos: ${ganhos}
• Perdidos: ${perdidos}

🎯 Meta:
• Quantidade: ${metaQuantidade}
• Percentual: ${metaConfig?.meta_percentual || 70}%

📈 Projeção (${diasRestantes} dias restantes):
• Ganhos Projetados: ${projection.ganhosProjetados}
• Assinados Projetados: ${projection.assinadosProjetados}
• Necessário por dia: ${projection.ganhosNecessariosPorDia} ganhos/dia
• Meta Projetada: ${projection.projecaoMeta ? '✅ SIM' : '❌ NÃO'}

💰 Financeiro:
• Comissão: ${formatCurrency(calculator.calculateCommission(assinados, 5))}
• Bônus: ${formatCurrency(calculator.calculateBonus(calculator.checkGoal(ganhos, assinados, metaQuantidade, metaConfig?.meta_percentual || 70) ? 1 : 0, ganhos, metaQuantidade))}`);
}

async function exportTeamData() {
    const permissions = accessControl.getUserPermissions(currentUser);
    if (!permissions.canExportData) {
        alert('Você não tem permissão para exportar dados.');
        return;
    }

    const members = await pool.query(
        `SELECT email, nome, nome_equipe, cargo, status, periodo
         FROM core.view_app_colaboradores
         WHERE nome_equipe = $1 AND LOWER(status) = 'ativo'`,
        [currentUser.equipe]
    );
    const filteredMembers = accessControl.filterTeamData(members.rows.map(m => ({
        id: m.email, nome: m.nome, equipe: m.nome_equipe, cargo: m.cargo, status: m.status
    })), currentUser);
    const rankedMembers = calculator.calculateRanking(filteredMembers);
    const csv = convertToCSV(rankedMembers);
    downloadCSV(csv, `equipe_${currentUser.equipe}_${selectedDate}.csv`);
}

function convertToCSV(data) {
    const headers = ['Ranking', 'ID', 'Nome', 'Equipe', 'Cargo', 'Status', 'Meta Individual', 'Comissão', 'Bônus', 'Bateu Meta', 'Pontuação', 'Última Atualização'];
    const rows = data.map(item => [
        item.ranking, item.id, item.nome, item.equipe, item.cargo, item.status, item.meta_individual,
        calculator.calculateCommission(item.assinados || 0, item.comissao_percentual || 5),
        calculator.calculateBonus(item.bateuMeta ? 1 : 0, item.ganhos || 0, item.meta_individual || 10),
        item.bateuMeta ? 'Sim' : 'Não',
        calculator.calculateTotalScore(item.ganhos || 0, item.assinados || 0),
        item.ultima_atualizacao
    ]);
    return [headers, ...rows].map(row => row.join(',')).join('\n');
}

function downloadCSV(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// ==================== FUNÇÕES DE DATA ====================

function applyDateFilter() {
    if (!currentUser || !isAuthenticated) return;

    const dateInput = elements.consultaDataMeta?.value;
    if (dateInput) {
        const parsedDate = parseDate(dateInput);
        if (parsedDate && !isNaN(parsedDate.getTime())) {
            selectedDate = parsedDate.toISOString().split('T')[0];
            loadUserDashboard();
            if (window.location.pathname.includes('equipes.html')) {
                const permissions = accessControl.getUserPermissions(currentUser);
                if (permissions.canViewTeam) loadTeamMembers();
            }
        } else {
            alert('Data inválida. Use o formato DD/MM/AAAA');
        }
    }
}

// ==================== FUNÇÕES DE CONFIGURAÇÃO DO CALCULATOR ====================

async function updateCalculatorConfig(newConfig) {
    if (!currentUser || !isAuthenticated) return false;

    const permissions = accessControl.getUserPermissions(currentUser);
    if (!permissions.canAdjustGoal) {
        alert('Você não tem permissão para ajustar configurações.');
        return false;
    }

    try {
        calculator.updateConfig(newConfig);
        await pool.query(
            `INSERT INTO app_comissionamento.configuracoes_usuario (usuario_id, peso_ganhos, peso_assinados, bonus_base, comissao_percentual_padrao, bonus_extra_por_meta)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (usuario_id) DO UPDATE SET peso_ganhos=$2, peso_assinados=$3, bonus_base=$4, comissao_percentual_padrao=$5, bonus_extra_por_meta=$6`,
            [currentUser.id, newConfig.pesoGanhos, newConfig.pesoAssinados, newConfig.bonusBase, newConfig.comissaoPercentualPadrao, newConfig.bonusExtraPorMeta]
        );
        await loadUserDashboard();
        return true;
    } catch (error) {
        console.error('Erro ao atualizar configurações:', error);
        return false;
    }
}

// ==================== FUNÇÕES DE LOGOUT ====================

function logout() {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
        .catch(() => {})
        .finally(() => {
            if (currentUser) {
                twoFactorService.clearCode(currentUser.id);
                twoFactorService.stopTimer();
            }

            currentUser = null;
            selectedDate = new Date().toISOString().split('T')[0];
            currentConfig = null;
            isAuthenticated = false;

            if (twoFactorTimer) clearInterval(twoFactorTimer);

            calculator.updateConfig({
                pesoGanhos: 3, pesoAssinados: 3, bonusBase: 10.00,
                comissaoPercentualPadrao: 5, bonusExtraPorMeta: 50.00
            });

            toggleMainContent(false);
            showPanel(elements.loginPanel, true);
            showPanel(elements.twoFactorVerifyPanel, false);

            const usernameInput = document.getElementById('username');
            const passwordInput = document.getElementById('password');
            const codeInput = document.getElementById('twoFactorCode');
            if (usernameInput) usernameInput.value = '';
            if (passwordInput) passwordInput.value = '';
            if (codeInput) codeInput.value = '';

            if (window.location.pathname.includes('equipes.html')) {
                window.location.href = '../index.html';
            }
        });
}

// ==================== NAVEGAÇÃO ====================

function navigateToTeamPage(e) {
    if (e) e.preventDefault();

    if (!currentUser || !isAuthenticated) {
        alert('Faça login primeiro');
        return;
    }

    const userLevel = accessControl.getAccessLevel(currentUser.cargo);
    if (userLevel === 1) {
        alert('Acesso Negado: Usuários do tipo ASSESSOR não têm permissão para acessar a página de equipes.');
        return;
    }

    const permissions = accessControl.getUserPermissions(currentUser);
    if (!permissions.canViewTeam) {
        alert('Você não tem permissão para visualizar dados da equipe.');
        return;
    }

    window.location.href = 'pages/equipes.html';
}

function navigateToIndex(e) {
    if (e) e.preventDefault();

    if (!currentUser || !isAuthenticated) {
        alert('Faça login primeiro');
        return;
    }

    window.location.href = '../index.html';
}

// ==================== INICIALIZAÇÃO DOS EVENTOS ====================

function initializeEventListeners() {
    const loginForm = document.getElementById('loginForm');
    if (loginForm) loginForm.addEventListener('submit', handleLogin);

    if (elements.closeLoginBtn) elements.closeLoginBtn.addEventListener('click', () => showPanel(elements.loginPanel, false));
    if (elements.closeVerifyBtn) elements.closeVerifyBtn.addEventListener('click', () => cancelTwoFactor());
    if (elements.verifyTwoFactorBtn) elements.verifyTwoFactorBtn.addEventListener('click', verifyTwoFactor);
    if (elements.cancelTwoFactorBtn) elements.cancelTwoFactorBtn.addEventListener('click', cancelTwoFactor);
    if (elements.resendCodeBtn) elements.resendCodeBtn.addEventListener('click', resendTwoFactorCode);

    if (elements.aplicarDataMetaBtn) elements.aplicarDataMetaBtn.addEventListener('click', applyDateFilter);
    if (elements.logoutBtn) elements.logoutBtn.addEventListener('click', logout);

    if (elements.exportarBtn) elements.exportarBtn.addEventListener('click', exportTeamData);
    if (elements.atualizarBtn) elements.atualizarBtn.addEventListener('click', loadTeamMembers);

    if (elements.linkEquipes) elements.linkEquipes.addEventListener('click', navigateToTeamPage);
    if (elements.linkIndex) elements.linkIndex.addEventListener('click', navigateToIndex);

    if (elements.consultaDataMeta) {
        elements.consultaDataMeta.addEventListener('input', (e) => {
            let value = e.target.value.replace(/\D/g, '');
            if (value.length >= 3) value = value.slice(0, 2) + '/' + value.slice(2);
            if (value.length >= 6) value = value.slice(0, 5) + '/' + value.slice(5, 9);
            e.target.value = value;
        });
    }
}

function initializePage() {
    toggleMainContent(false);
    initializeEventListeners();

    if (twoFactorService.setApiBaseUrl) {
        twoFactorService.setApiBaseUrl(window.location.origin);
    }

    showPanel(elements.loginPanel, true);
    showPanel(elements.twoFactorVerifyPanel, false);

    console.log('Calculator inicializado com configurações:', calculator.getConfig());
    console.log('Sistema de controle de acesso inicializado');
}

function checkInitialAuth() {
    if (!isAuthenticated && !window.location.pathname.includes('index.html')) {
        window.location.href = '../index.html';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initializePage();
    checkInitialAuth();
    checkPageAccess();
});

export {
    handleLogin,
    logout,
    loadUserDashboard,
    loadTeamMembers,
    applyDateFilter,
    formatCurrency,
    updateCalculatorConfig,
    calculator,
    accessControl
};