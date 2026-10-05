CREATE TABLE IF NOT EXISTS app_comissionamento.movimentacoes_linkhub_lotes (
  id_lote BIGSERIAL PRIMARY KEY,
  solicitante_email TEXT NOT NULL,
  solicitante_nome TEXT NOT NULL,
  solicitante_equipe TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  request_hash CHAR(64) NOT NULL,
  equipe_destino_nome TEXT NOT NULL,
  colaborador_destino_nome TEXT NOT NULL,
  colaborador_destino_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'processando', 'concluido', 'parcial', 'erro')),
  total_itens INTEGER NOT NULL DEFAULT 0,
  concluidos INTEGER NOT NULL DEFAULT 0,
  falhos INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mov_linkhub_lote_request UNIQUE (solicitante_email, idempotency_key)
);

CREATE TABLE IF NOT EXISTS app_comissionamento.movimentacoes_linkhub_itens (
  id_item BIGSERIAL PRIMARY KEY,
  id_lote BIGINT NOT NULL REFERENCES app_comissionamento.movimentacoes_linkhub_lotes(id_lote) ON DELETE CASCADE,
  deal_id TEXT NOT NULL,
  portal_id TEXT NOT NULL,
  link_hub TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'processando', 'concluido', 'erro', 'bloqueado')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  processando_desde TIMESTAMPTZ,
  proxima_tentativa_em TIMESTAMPTZ,
  pipeline_original TEXT,
  etapa_original TEXT,
  owner_original TEXT,
  owners_contatos_originais JSONB NOT NULL DEFAULT '[]'::jsonb,
  ids_contatos JSONB NOT NULL DEFAULT '[]'::jsonb,
  resultado JSONB NOT NULL DEFAULT '{}'::jsonb,
  erro TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  concluido_em TIMESTAMPTZ,
  CONSTRAINT uq_mov_linkhub_lote_deal UNIQUE (id_lote, deal_id)
);

CREATE INDEX IF NOT EXISTS idx_mov_linkhub_itens_fila
  ON app_comissionamento.movimentacoes_linkhub_itens (status, id_item);

CREATE INDEX IF NOT EXISTS idx_mov_linkhub_itens_lote
  ON app_comissionamento.movimentacoes_linkhub_itens (id_lote, status);

CREATE INDEX IF NOT EXISTS idx_mov_linkhub_lotes_solicitante
  ON app_comissionamento.movimentacoes_linkhub_lotes (solicitante_email, criado_em DESC);
