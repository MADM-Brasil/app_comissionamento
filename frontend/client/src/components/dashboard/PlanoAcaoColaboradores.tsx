// src/components/plano-acao/PlanoAcaoColaboradores.tsx
import { useState, useMemo } from "react";
import { Card } from "@/components/ui/card";
import { formatNumero } from "@/lib/format";
import { Link } from "wouter";
import type { Collaborator } from "@/lib/dataStore";

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

function CollaboratorCard({ colab }: { colab: Collaborator }) {
  return (
    <Link href={`/colaboradores/${colab.id}`}>
      <Card className="flex flex-col gap-3 p-4 hover:shadow-md transition-shadow cursor-pointer">
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
  // Colaboradores que precisam de atenção (menos de 2 assinados e ativos)
  const comProducao = useMemo(
    () =>
      colaboradores.filter(
        (c) =>
          c.status === "ativo" &&
          c.assinados < 2
      ),
    [colaboradores]
  );

  const precisamAtencao = comProducao.length;

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

      {/* Lista de colaboradores */}
      {comProducao.length === 0 ? (
        <p className="text-sm text-slate-500 py-6 text-center">
          Nenhum colaborador precisa de atenção no momento.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {comProducao.map((colab) => (
            <CollaboratorCard key={colab.id} colab={colab} />
          ))}
        </div>
      )}
    </Card>
  );
}