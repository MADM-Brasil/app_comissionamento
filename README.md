# Sistema-Comissionamento
Sistema que calcula o comissionamento de colaboradores da empresa MADM Brasil.

passo á passo do sistema

acesso 2FN
    login e-mail
    senha 

informações principais
    login:
        nome do cloaborador
        equipe

    comissionamento:
        emitidos
        assinados
        ganhos
        perdidos
        Meta
        Bonus
        Comissão

-----------------------------------------------------------------------------------------

controle

    Informações de interesse do Banco (Usuários)
        - internal_id
        - colaborador
        - e_mail
        - id_equipe
        - equipe
        - grupo (Desativado, Elite, Supervisor, AnÃ¡lise de segurado, Concomitante, Juridico, Ultravita, SAC, QuinquÃªnio, Ultravita, Coordenador, ProntuÃ¡rio, CEO, Salesops, Administrativo, Diligencia, ComunicaÃ§Ã£o, Ganho, Marketing, Contrato, GerÃªncia, Dr. Felipe Marx, NULL, Assistente)
        - status (Comercial, Desativado, JurÃdico, Infoproduto, Backoffice)
    
    Não consultar

        -GRUPO: Desativado, Juridico, Ultravita, ProntuÃ¡rio, Diligencia, ComunicaÃ§Ã£o, Ganho, Marketing, Dr. Felipe Marx, NULL

            validar: Administrativo, Assistente, GerÃªncia

        -STATUS: Desativado, JurÃdico, Infoproduto, 


    Nivel de acesso (hierarquia)
       
            Nivel          |                Grupo
---------------------------|-------------------------------------------------------------
    Desc                   | Desativado, Juridico, Ultravita, ProntuÃ¡rio, Diligencia,   
                           | ComunicaÃ§Ã£o, Ganho, Marketing, Dr. Felipe Marx, NULL
                           |
    Assessor               | Elite, AnÃ¡lise de segurado, Concomitante, QuinquÃªnio
                           |
    Supervisão             | Supervisor
                           |
    Coordenador            | Coordenador
                           |
    Administrativo         | Salesops, CEO, administrativo(validar)

    
   Permissões:

    Desc            =     Não mostrar, sem acesso  --- Pode ser solucionado se o sistema não fazer a consulta desse grupo 
    Assessor        =     Visualizar 
    Supervisão      =     Visão equipe + anterior 
    Coordenador     =     Visão equipes + ajuste peso meta + anterior 
    Administrativo  =     Ajuste bônus + anterior

select internal_id, colaborador, e_mail, equipe, grupo , status, periodo
  from madm.colaboradores
  WHERE 
  periodo = '2026-04' and
  grupo in ('Elite','Supervisor','Análise de segurado','Concomitante','Salesops','Quinquenio','Coordenador','CEO','Diretoria')

-----------------------------------------------------------------------------------------

Cores

 * Primary: #09175b | Success: #34a853 | Ice: #c8eaed | Emerald: #045b5b | Gold: #ffcc00

-----------------------------------------------------------------------------------------

Calculo do peso da meta na página de relatório:

    Para um intervalo de 14 dias com meta diária = 3, a meta total deveria ser 3 × 14.

    Para um intervalo de 10 semanas com meta semanal = 15, a meta total deveria ser 15 × 10.

    Para um intervalo de 3 meses com meta mensal = 60, a meta total deveria ser 60 × 3.

Exemplo:

    Para um mês completo (30 dias): meta diária = 3 × 30 = 90; meta semanal = 15 × 4.3 ≈ 64.5; meta mensal = 60 × 1 = 60.

    Para uma semana exata (7 dias): meta diária = 3 × 7 = 21; meta semanal = 15 × 1 = 15; meta mensal = 60 × 0.23 ≈ 14 (arredondado).

    Para um dia único: meta diária = 3 × 1 = 3; meta semanal = 15 × 0.14 ≈ 2; meta mensal = 60 × 0.03 ≈ 2.


Calculo para desempenho do colaborador

       Desempenho individual - A função RadarConversaoLigacoes transforma o número de assinados de cada colaborador em um índice de 0 a 100:

       value = Math.max(0, Math.min(100, (colab.assinados || 0) * 10))

Calculo para Melhor colaborador e Precisa de atenção

       Melhor colaborador: aquele com maior número de assinados na lista filtrada.

       Precisa de atenção: aquele com menor número de assinados.
-------------------------------------------------------------------------------------------

Mudança para views:

            Nivel          |                Grupo
---------------------------|-------------------------------------------------------------
    Desc                   | status = desativado
                           | cargo = Assistente,Analista Juridico,Gestor de projetos
                           | Analista, Analista Juridico, Analista de discadora
                           |
    Assessor               | Assessor, Analista de pastas
                           |
    Supervisão             | Supervisor
                           |
    Coordenador            | Coordenador
                           |
    Administrativo         | Salesops, Analista de CRM,Desenvolvedor,Diretora,
                           | Analista de dados, Desenvolvedor Make
                           |
    SUPER_ADMIN            | Desenvolvedor, CEO, diretora                                     

Equipe.tsx

Card do colaborador

Atual (linha azul): os dados do período que você selecionou no filtro de datas do topo da página.
Exemplo: se você escolheu o mês de agosto de 2026, a linha azul mostra quantos assinados o colaborador teve em cada dia de agosto.

Anterior (linha laranja): os dados do período imediatamente anterior, com a mesma duração do período atual.
Exemplo: para o mês de agosto (31 dias), o período anterior será julho de 2026 (também 31 dias). Se você escolheu um intervalo customizado de 10 dias, o anterior será os 10 dias imediatamente anteriores a esse intervalo.


.env
# ========== OBRIGATÓRIAS ==========
PORT=3007
NODE_ENV=production
DATABASE_URL=postgres://usuario:senha@host:5432/db?schema=madm
SESSION_SECRET=substitua-por-uma-string-aleatoria-forte
ALLOWED_ORIGINS=https://app.seudominio.com,https://seudominio.com
FRONTEND_URL=https://app.seudominio.com

# ========== E-MAIL (2FA / recuperação) ==========
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=seu-email@gmail.com
EMAIL_PASS=senha-de-app

# ========== INTEGRAÇÕES ==========
KOMMO_API_TOKEN=seu-token
CHV_Hubspot=seu-token-hubspot
WEBHOOK_CASOS_DISCADORA=sua-url-webhook
# ... (todas as outras)

# ========== OPCIONAL ==========
CORS_ENABLED=true

1. Aviso (status: 'aviso')
Quando ocorre:
Contato não encontrado e o usuário preencheu apenas telefone, sem e‑mail ou CPF.

Mensagem:
"Campos pendentes: preencha e‑mail ou CPF para tentar novamente."

Sucesso: false

Observação:
O registro é gravado no banco com status de aviso para acompanhamento.

2. Suporte (status: 'suporte')
Quando ocorre:
Contato encontrado, porém os dados informados divergem do cadastro existente (e‑mail, telefone ou CPF).

Mensagem:
"Dados divergentes do cadastro: <campos divergentes>."

Sucesso: false

Observação:
O ticket fica com status de suporte para análise manual.

3. Bloqueado (status: 'bloqueado')
Quando ocorre:

Card (negócio) em pipeline diferente de Base de Leads e não está com o colaborador informado.

Card já está com o colaborador informado, mas em outro pipeline (opcional).

Mensagens:

"Movimentação bloqueada: Card em pipeline 'X'."

"Card já está com o colaborador 'X'."

Sucesso: false

Observação:
A movimentação não é realizada.

4. Erro (status: 'erro')
Quando ocorre:
Falha na integração com o HubSpot (exceção não tratada, autenticação, erro de API).

Mensagem:
"Erro na integração HubSpot: <detalhes>."

Sucesso: false

5. Concluído (status: 'concluido')
Quando ocorre:
Card movido com sucesso para o pipeline Closer, fase Em Contato (ou quando a movimentação é bem-sucedida).

Mensagem:
"Card movido"

Sucesso: true

6. Fora do Pipeline (status: 'fora_pipeline')
Quando ocorre:
Situação atípica em que a movimentação não foi bloqueada, mas o card não está no pipeline/estágio esperado após a operação.

Mensagem:
Normalmente não é exibida diretamente, pois o sistema tende a classificar como concluído ou bloqueado.

Sucesso: true (genérico)

Resumo dos status utilizados na prática
Status	Cor/Badge	Sucesso	Mensagem principal
aviso	Amarelo/Laranja	false	Campos pendentes
suporte	Laranja	false	Dados divergentes
bloqueado	Vermelho	false	Card em pipeline não permitido
erro	Vermelho	false	Erro na integração
concluido	Verde	true	Card movido
Esses são os retornos definidos ao longo das alterações. O frontend (Suporte.tsx) já possui os mapeamentos de ícones e cores correspondentes para exibição no histórico.

