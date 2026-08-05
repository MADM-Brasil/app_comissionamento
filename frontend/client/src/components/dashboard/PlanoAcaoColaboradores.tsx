// src/components/plano-acao/PlanoAcaoColaboradores.tsx
import { useState, useMemo } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatNumero } from "@/lib/format";
import { Link } from "wouter";
import type { Collaborator } from "@/lib/dataStore";

// ========== TIPOS E CLASSIFICAÇÃO ==========
type NivelStatus = "excelente" | "bom" | "atencao" | "alerta" | "critico";

const STATUS_COLOR: Record<NivelStatus, string> = {
  excelente: "#22c55e",
  bom: "#3b82f6",
  atencao: "#f59e0b",
  alerta: "#f97316",
  critico: "#ef4444",
};

const STATUS_LABEL: Record<NivelStatus, string> = {
  excelente: "Excelente",
  bom: "Bom",
  atencao: "Atenção",
  alerta: "Alerta",
  critico: "Crítico",
};

function classificarConversao(protocolados: number, assinados: number): NivelStatus {
  if (assinados === 0) return "critico";
  const taxa = (protocolados / assinados) * 100;
  if (taxa >= 80) return "excelente";
  if (taxa >= 60) return "bom";
  if (taxa >= 40) return "atencao";
  if (taxa >= 20) return "alerta";
  return "critico";
}

// ========== COMPONENTES AUXILIARES ==========
function AvatarLocal({ nome, size = 32 }: { nome: string; size?: number }) {
  const inicial = (nome || "?")[0].toUpperCase();
  return (
    <div
      className="flex items-center justify-center rounded-full bg-blue-500 text-white font-bold"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {inicial}
    </div>
  );
}

function StatusPillLocal({ status }: { status: NivelStatus }) {
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
      style={{
        backgroundColor: `${STATUS_COLOR[status]}20`,
        color: STATUS_COLOR[status],
      }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function CollaboratorCard({ colab }: { colab: Collaborator }) {
  const status = classificarConversao(colab.protocolados, colab.assinados);

  return (
    <Link href={`/colaboradores/${colab.id}`}>
      <Card className="flex flex-col gap-3 p-4 hover:shadow-md transition-shadow cursor-pointer">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AvatarLocal nome={colab.name} size={36} />
            <div>
              <p className="text-sm font-semibold text-slate-900 truncate max-w-[160px]">
                {colab.name}
              </p>
              <p className="text-xs text-slate-500 truncate max-w-[160px]">
                {colab.equipeNome}
              </p>
            </div>
          </div>
          <StatusPillLocal status={status} />
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <div>
            <span className="text-slate-500">Assinados</span>
            <p className="font-semibold text-slate-800">{formatNumero(colab.assinados)}</p>
          </div>
          <div>
            <span className="text-slate-500">Protocolados</span>
            <p className="font-semibold text-slate-800">{formatNumero(colab.protocolados)}</p>
          </div>
          <div>
            <span className="text-slate-500">Meta mensal</span>
            <p className="font-semibold text-slate-800">{formatNumero(colab.metaMensalAssinados || 0)}</p>
          </div>
          <div>
            <span className="text-slate-500">Conversão</span>
            <p className="font-semibold text-slate-800">
              {colab.assinados > 0
                ? `${((colab.protocolados / colab.assinados) * 100).toFixed(0)}%`
                : "—"}
            </p>
          </div>
        </div>
      </Card>
    </Link>
  );
}

// ========== COMPONENTE PRINCIPAL ==========
interface PlanoAcaoColaboradoresProps {
  colaboradores: Collaborator[];
  diasUteisPeriodo: number;
}

export function PlanoAcaoColaboradores({
  colaboradores,
  diasUteisPeriodo,
}: PlanoAcaoColaboradoresProps) {
  const [filtroStatus, setFiltroStatus] = useState<NivelStatus | null>(null);

  // Colaboradores que realmente produzem (exclui supervisores e inativos)
  const comProducao = useMemo(
    () =>
      colaboradores.filter(
        (c) =>
          c.status === "ativo" &&
          c.assinados < 2 // critério de "precisa de atenção"
      ),
    [colaboradores]
  );

  // Adiciona status a cada colaborador
  const comStatus = useMemo(
    () =>
      comProducao.map((c) => ({
        colaborador: c,
        status: classificarConversao(c.protocolados, c.assinados),
      })),
    [comProducao]
  );

  const precisamAtencao = comStatus.length;

  // Filtra por status selecionado (se houver) e ordena do pior para o melhor
  const linhas = useMemo(
    () =>
      comStatus
        .filter((x) => !filtroStatus || x.status === filtroStatus)
        .sort((a, b) => a.colaborador.assinados - b.colaborador.assinados),
    [comStatus, filtroStatus]
  );

  const STATUS_FILTROS: NivelStatus[] = ["critico", "alerta", "atencao", "bom", "excelente"];

  return (
    <Card>
      <div className="mb-5">
        <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
          <h3 className="text-base font-semibold text-slate-900">Plano de ação por colaborador</h3>
        </div>
        <p className="text-[13px] text-slate-500">
          {precisamAtencao === 0
            ? "Nenhum colaborador precisa de atenção agora."
            : `${precisamAtencao} colaborador(es) com menos de 2 assinados no período.`}
        </p>
        <p className="text-[13px] text-slate-400 mt-1">
          Dias úteis no período: {diasUteisPeriodo}
        </p>
      </div>

      {/* Filtros por status */}
      <div className="flex flex-wrap gap-2 mb-5">
        <button
          onClick={() => setFiltroStatus(null)}
          className={cn(
            "rounded-full px-3.5 py-1.5 text-[12px] font-medium border transition-colors",
            filtroStatus === null
              ? "bg-blue-500/15 border-blue-500/40 text-blue-700"
              : "border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-100"
          )}
        >
          Todos
        </button>
        {STATUS_FILTROS.map((status) => (
          <button
            key={status}
            onClick={() => setFiltroStatus(status)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-[12px] font-medium border transition-colors",
              filtroStatus !== status &&
                "border-slate-200 text-slate-500 hover:text-slate-700 hover:bg-slate-100"
            )}
            style={
              filtroStatus === status
                ? {
                    backgroundColor: `${STATUS_COLOR[status]}1a`,
                    borderColor: `${STATUS_COLOR[status]}66`,
                    color: STATUS_COLOR[status],
                  }
                : undefined
            }
          >
            {STATUS_LABEL[status]}
          </button>
        ))}
      </div>

      {/* Lista de colaboradores */}
      {linhas.length === 0 ? (
        <p className="text-sm text-slate-500 py-6 text-center">
          Nenhum colaborador nessa faixa de status.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {linhas.map(({ colaborador, status }) => (
            <CollaboratorCard key={colaborador.id} colab={colaborador} />
          ))}
        </div>
      )}
    </Card>
  );
}