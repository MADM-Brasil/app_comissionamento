import { X } from "lucide-react";
import { Card } from "@/components/ui/Card";
import type { Collaborator } from "@/lib/dataStore";
import { formatNumero } from "@/lib/format";

interface DetalheAssinadosModalProps {
  titulo: string;
  colaboradores: Collaborator[];
  atual: number;
  onFechar: () => void;
}

export function DetalheAssinadosModal({ titulo, colaboradores, atual, onFechar }: DetalheAssinadosModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
      <Card className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-0 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{titulo}</h3>
            <p className="text-sm text-slate-500">Total atual: {formatNumero(atual)}</p>
          </div>
          <button onClick={onFechar} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Fechar modal">
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-auto p-5">
          <div className="space-y-2">
            {colaboradores.length === 0 ? (
              <p className="text-sm text-slate-500">Nenhum colaborador disponível para esse filtro.</p>
            ) : (
              colaboradores.map((colab) => (
                <div key={colab.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                  <div>
                    <p className="text-sm font-medium text-slate-900">{colab.name}</p>
                    <p className="text-xs text-slate-500">{colab.equipeNome}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-slate-900">{formatNumero(colab.assinados || 0)}</p>
                    <p className="text-xs text-slate-500">assinados</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
