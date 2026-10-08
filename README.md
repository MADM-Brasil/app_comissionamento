# Sistema-Comissionamento
Sistema que calcula o comissionamento de colaboradores e também faz movimentação, alteração de proprietarios e notificação de reports da empresa MADM Brasil.

passo á passo de login e cadastro do sistema

1° Criação de usuários   
    => Colaborador precisa ter o acesso criado dentro do app_comissionamento.metricas_assessores e na core.colaboradores para envio do código de acesso via e-mail
e para o sisitema conseguir puxar dados referentes ao usuário como por exemplo: Equipe.
        Pronpt para criação de usuários na app_comissionamento.metricas_assessores:

    INSERT INTO app_comissionamento.metricas_assessores 
(id_assessor, email, data_metrica, comissao_bonus, colaborador, classificacao_operacional, peso_meta_ganho_diario,peso_meta_ganho_semanal,peso_meta_ganho_mensal)
VALUES 
  (1, 'email@@madmbrasil.com.br', '2026-10-01', 1, 'nome', 'Discador',1,1,1)

OBS: id_assessor, email e colaborador precisam ser os mesmos da core. data_metrica sempre referente ao dia 1 do mês do registro

2° acesso do colaborador
    => Primiero acesso precisa ser feito indo primeiro em "Esqueci a minnha senha" para registrar a senha do usuario dentro do app_comissionamento.metricas_assessores

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
# CAMPANHAS

É possivel registrar campanhas e ativa-las na página configuration.tsx, cada campanha possui um modelo especifico, faixa de comissão e regras registradas dentro do campanhas.js

Atuais campanhas:

GOLS, subcampanhas:
  -assinados
  -gols
  -progressiva

CAMPGANHOS_2026, subcampanhas:
  -diaria
  -semanal
  -mensal

# FAIXAS DE COMISSAO

A comissão é calculada por meio das faixas atingidas pelo colaborador. Os colaboradores possuem uma faixa de comissão padrão e uma faixa especifica por campanha. As campanhas só são levadas em consideração para o calculo quando ativas no periodo.

Exemplo de faixa:

  campanha= X, faixa_min = 5, faixa_max = 10, valor = R$10

Regra: Campanha x calcula a faixa por meio da quantidade de ganhos, logo caso o colaborador tenha entre 5 a 10 ganhos ele receberá R$10
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
HUBSPOT_PORTAL_ID=id-do-portal-da-conta-hubspot
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

# ========== RECOMENDAÇÕES ==========

Caso a taxa de ligações produtivas seja +50% das ligações totais retorna a mensagem:
        🎉 Parabéns! "tantos"% das suas ligações foram produtivas no período. Excelente trabalho — continue assim!

Caso a taxa de ligações produtivas seja -40% das ligações totais retorna a mensagem:
        Apenas "tantos"% das suas ligações foram produtivas. Revise o script de abordagem e o horário dos contatos.

Caso a taxa de ligações produtivas seja +5% das ligações totais retorna a mensagem:
        Você registrou "tantos"% de agendamentos. Ótimo ritmo! Melhores horários para uma nova tentativa de contato: 8:10, 10:12 e 12:14.

Caso tenha + de 3 casos de "Não Tabulada - Tempo Excedido" retorna a mensagem:
        Foram registradas "tantas" ocorrências de "Não Tabulada - Tempo Excedido" no período. Evite deixar atendimentos sem a devida tabulação.

Caso a taxa de Quedas de ligações seja +10% das ligações totais retorna a mensagem:
        Você tem tantas% de quedas de ligação. Recomendamos acompanhar a estabilidade da rede e a conexão com a internet. 
        OBS: a tabulação de "Queda" deve ser utilizada quando a ligação for encerrada antes da conclusão do atendimento.

Caso a taxa de ligações mudas seja +10% das ligações totais retorna a mensagem:
        "tantos"% das ligações foram tabuladas como "Mudas". Recomendamos que verifique o funcionamento dos equipamentos e separe os casos para serem avaliados por nossa equipe.
        OBS: A tabulção de Ligaçoes mudas deve ser utilizada quando não houver comunicação/áudio do cliente.
