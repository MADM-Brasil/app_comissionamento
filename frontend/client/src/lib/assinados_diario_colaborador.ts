// src/lib/assinadosDiarioColaborador.ts

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3007/api";

function normalizarNome(nome: string): string {
  return (nome || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export interface AssinadosDiarioColaboradorLinha {
  dia: string;
  total: number;
}

interface LinhaBruta {
  dia: string;
  colaborador: string | null;
  total: string | number;
}

/** Tenta a requisição até 3 vezes antes de desistir (picos passageiros de conexão). */
async function fetchComRetry(url: string, tentativas = 3): Promise<any> {
  let ultimoErro: unknown;
  for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
    try {
      const resposta = await fetch(url, { credentials: "include" });
      const dados = await resposta.json();
      if (resposta.ok && dados.success) return dados;
      if (resposta.status < 500 || tentativa === tentativas) {
        throw new Error(dados.error ?? "Não foi possível carregar a evolução do colaborador.");
      }
      ultimoErro = new Error(dados.error ?? "Não foi possível carregar a evolução do colaborador.");
    } catch (err) {
      ultimoErro = err;
      if (tentativa === tentativas) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, tentativa * 800));
  }
  throw ultimoErro;
}

/**
 * Assinados por dia de um único colaborador no intervalo.
 */
export async function fetchAssinadosDiarioColaborador(
  nomeColaborador: string,
  inicio: string,
  fim: string
): Promise<AssinadosDiarioColaboradorLinha[]> {
  const url = `${API_BASE}/metrics/assinados-diario-colaborador?inicio=${inicio}&fim=${fim}`;
  const dados = await fetchComRetry(url);

  const chave = normalizarNome(nomeColaborador);
  return (dados.data as LinhaBruta[])
    .filter((l) => l.colaborador && normalizarNome(l.colaborador) === chave)
    .map((l) => ({
      dia: typeof l.dia === "string" ? l.dia.slice(0, 10) : l.dia,
      total: typeof l.total === "number" ? l.total : Number(l.total) || 0,
    }));
}

export async function fetchAssinadosDiarioTodos(
  inicio: string,
  fim: string
): Promise<Map<string, AssinadosDiarioColaboradorLinha[]>> {
  const url = `${API_BASE}/metrics/assinados-diario-colaborador?inicio=${inicio}&fim=${fim}`;
  const dados = await fetchComRetry(url);

  const porConsultor = new Map<string, AssinadosDiarioColaboradorLinha[]>();
  for (const l of dados.data as LinhaBruta[]) {
    if (!l.colaborador) continue;
    const chave = normalizarNome(l.colaborador);
    const linha: AssinadosDiarioColaboradorLinha = {
      dia: typeof l.dia === "string" ? l.dia.slice(0, 10) : l.dia,
      total: typeof l.total === "number" ? l.total : Number(l.total) || 0,
    };
    if (!porConsultor.has(chave)) porConsultor.set(chave, []);
    porConsultor.get(chave)!.push(linha);
  }
  return porConsultor;
}