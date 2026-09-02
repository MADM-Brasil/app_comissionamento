// client/src/pages/Suporte.tsx
import React, { useState, useEffect, useMemo, useRef } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import {
  Send,
  X,
  Download,
  Eye,
  Loader2,
  CheckCircle,
  Clock,
  AlertCircle,
  AlertTriangle,
  FileText,
  Edit2,
  Save,
  Upload,
  Paperclip,
  Ban,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/lib/dataStore";
import { useAccessControl } from "@/hooks/useAccessControl";
import { API_BASE } from "@/lib/api";

// ---------------------- Tipos ----------------------
interface MovementItem {
  id: string;
  timestamp: string;
  cliente: string;
  email: string;
  telefone: string;
  cpf: string;
  origem: string;
  equipe: string;
  assessor: string;
  status: "pendente" | "processando" | "concluido" | "suporte" | "aviso" | "erro";
  resultado: string;
  usuario: string;
  atualizadoEm: string;
  observacao_sales_ops?: string;
  hubspot?: {
    contactId?: string;
    existe?: boolean;
    pipeline?: string;
    stage?: string;
    status?: string;
    erro?: boolean;
    mensagem?: string;
  };
}

interface ReportItem {
  id: string;
  data: string;
  titulo: string;
  assunto: string;
  descricao: string;
  descricaoResumida: string;
  solicitante: string;
  equipe: string;
  status: "ENVIADO" | "SUSPEITO" | "CONCLUÍDO" | "ERRO" | "BLOQUEADO" | "REVISÃO" | "ANALISE" | "CANCELADO";
  observacao_sales_ops: string;
  ultimaAtualizacao: string;
}

interface TicketMovimentacao {
  id_ticket_movimentacao: number;
  crm_origem: string;
  tipo_solicitacao: string;
  nome_cliente_informado: string;
  sobrenome_cliente_informado: string;
  email_cliente_informado: string;
  telefone_cliente_informado: string;
  cpf_cliente_informado: string;
  origem_cliente_informada: string;
  colaborador_origem_nome: string;
  equipe_origem_nome: string;
  colaborador_destino_nome: string;
  equipe_destino_nome: string;
  status_mapeamento: string;
  observacao_sales_ops?: string;
  motivo_solicitacao?: string;
  criado_em: string;
}

interface TicketSuporte {
  id_ticket_suporte: number;
  assunto: string;
  titulo: string;
  descricao: string;
  solicitante_nome: string;
  equipe_nome: string;
  status: string;
  observacao_sales_ops?: string;
  criado_em: string;
}

// ---------------------- Helpers ----------------------
// Formata DDD+número (sem código do país)
const formatPhoneInput = (phone: string): string => {
  let numbers = phone.replace(/\D/g, "");

  // Se colar com código do país (55) remove para manter apenas DDD+número
  if (numbers.startsWith("55") && numbers.length >= 12) {
    numbers = numbers.slice(2);
  }

  // Limita a 11 dígitos (DDD + 9 dígitos)
  numbers = numbers.slice(0, 11);

  // Aplica máscara: (DD) NNNNN-NNNN ou (DD) NNNN-NNNN
  if (numbers.length <= 2) {
    return numbers;
  } else if (numbers.length <= 6) {
    return `(${numbers.slice(0, 2)}) ${numbers.slice(2)}`;
  } else if (numbers.length <= 10) {
    return `(${numbers.slice(0, 2)}) ${numbers.slice(2, 6)}-${numbers.slice(6)}`;
  } else {
    return `(${numbers.slice(0, 2)}) ${numbers.slice(2, 7)}-${numbers.slice(7)}`;
  }
};

// Valida se o telefone (DDD+número) é válido
const isValidBrazilianPhone = (phone: string): boolean => {
  const digits = phone.replace(/\D/g, '');
  if (digits.length !== 10 && digits.length !== 11) return false;

  const ddd = digits.slice(0, 2);
  const number = digits.slice(2);
  const dddNum = parseInt(ddd, 10);

  // DDD não pode ser 55 nem estar fora da faixa 11-99
  if (isNaN(dddNum) || dddNum < 11 || dddNum > 99 || ddd === '55') return false;

  // Número deve ter 8 ou 9 dígitos
  if (number.length !== 8 && number.length !== 9) return false;

  return true;
};

const formatCPF = (cpf: string): string => {
  const numbers = cpf.replace(/\D/g, "");
  if (numbers.length <= 3) return numbers;
  if (numbers.length <= 6) return `${numbers.slice(0, 3)}.${numbers.slice(3)}`;
  if (numbers.length <= 9) return `${numbers.slice(0, 3)}.${numbers.slice(3, 6)}.${numbers.slice(6)}`;
  return `${numbers.slice(0, 3)}.${numbers.slice(3, 6)}.${numbers.slice(6, 9)}-${numbers.slice(9, 11)}`;
};

const normalize = (str: string): string => (str || '').trim().toLowerCase();

const isWithinDateRange = (dateISO: string, startDate?: string, endDate?: string): boolean => {
  if (!startDate && !endDate) return true;
  const dateStr = new Date(dateISO).toISOString().slice(0, 10);
  if (startDate && dateStr < startDate) return false;
  if (endDate && dateStr > endDate) return false;
  return true;
};

const getTodayString = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getStatusInfo = (status: string) => {
  const map: Record<string, { label: string; icon: React.ReactElement; className: string }> = {
    pendente: { label: "Pendente", icon: <Clock className="w-3 h-3" />, className: "bg-gray-100 text-gray-600" },
    processando: { label: "Processando", icon: <Loader2 className="w-3 h-3 animate-spin" />, className: "bg-blue-50 text-blue-700" },
    concluido: { label: "Concluído", icon: <CheckCircle className="w-3 h-3" />, className: "bg-green-50 text-green-700" },
    suporte: { label: "Suporte", icon: <AlertCircle className="w-3 h-3" />, className: "bg-orange-50 text-orange-700" },
    aviso: { label: "Aviso", icon: <AlertTriangle className="w-3 h-3" />, className: "bg-yellow-50 text-yellow-700" },
    erro: { label: "Erro", icon: <AlertCircle className="w-3 h-3" />, className: "bg-red-50 text-red-700" },
    no_pipeline: { label: "No Pipeline", icon: <CheckCircle className="w-3 h-3" />, className: "bg-green-50 text-green-700" },
    fora_pipeline: { label: "Fora do Pipeline", icon: <AlertTriangle className="w-3 h-3" />, className: "bg-yellow-50 text-yellow-700" },
    bloqueado: { label: "Bloqueado", icon: <Ban className="w-3 h-3" />, className: "bg-red-100 text-red-800" },
    ENVIADO: { label: "Enviado", icon: <Send className="w-3 h-3" />, className: "bg-blue-50 text-blue-700" },
    SUSPEITO: { label: "Suspeito", icon: <AlertTriangle className="w-3 h-3" />, className: "bg-yellow-50 text-yellow-700" },
    CONCLUÍDO: { label: "Concluído", icon: <CheckCircle className="w-3 h-3" />, className: "bg-green-50 text-green-700" },
    ERRO: { label: "Erro", icon: <AlertCircle className="w-3 h-3" />, className: "bg-red-50 text-red-700" },
    BLOQUEADO: { label: "Bloqueado", icon: <X className="w-3 h-3" />, className: "bg-red-100 text-red-800" },
    ANALISE: { label: "Análise", icon: <Eye className="w-3 h-3" />, className: "bg-purple-50 text-purple-700" },
    REVISÃO: { label: "Revisão", icon: <Eye className="w-3 h-3" />, className: "bg-purple-50 text-purple-700" },
    CANCELADO: { label: "Cancelado", icon: <Ban className="w-3 h-3" />, className: "bg-gray-100 text-gray-500" },
  };
  return map[status] || { label: status, icon: <FileText className="w-3 h-3" />, className: "bg-gray-100 text-gray-600" };
};

const EXCLUDED_TEAMS = [
  'Coordenacao Closer', 'Departamento Backoffice', 'Diretoria','Departamento Marketing',
  'Equipe Ariana', 'Equipe Erika', 'Equipe Leonardo', 'Equipe Leticia', 'Equipe Michael','Equipe Erica',
  'Equipe Thales', 'Equipe Yuri', 'Equipe Rodolfo','Equipe Jennifer','Equipe Natalia','Equipe Maria Eduarda',
  'Equipe Reciclagem','','Equipe','Equipe Camila','Sales Ops', 'Departamento Comercial', 'Equipe Gabriela Toledo'
];

const isExcludedTeam = (teamName: string): boolean => {
  if (!teamName) return false;
  const n = teamName.trim().toLowerCase();
  return EXCLUDED_TEAMS.some(t => t.trim().toLowerCase() === n);
};

function getCsrfHeaders() {
  const token = localStorage.getItem('csrfToken') || '';
  return {
    'Content-Type': 'application/json',
    'x-csrf-token': token,
  };
}

export default function Suporte() {
  const [activeTab, setActiveTab] = useState<"movimentacao" | "reportar" | "salesops">("reportar");
  const { getAccessLevel, LEVELS } = useAccessControl();

  const isAdmin = useMemo(() => {
    const level = getAccessLevel();
    return level === LEVELS.ADMINISTRATIVO || level === LEVELS.SUPER_ADMIN;
  }, [getAccessLevel, LEVELS]);

  return (
    <DashboardLayout title="Suporte Operacional" subtitle="Movimentação de leads e reporte de problemas">
      <div className="mb-6 border-b border-[#e2e8f0]">
        <div className="flex gap-2">
          {[
            { id: "reportar", label: "🔍 Reportar" },
            { id: "movimentacao", label: "📋 Movimentar" },
            ...(isAdmin ? [{ id: "salesops", label: "📊 Visão SalesOps" }] : []),
          ].map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={cn(
                "filter-pill",
                activeTab === tab.id && "active"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      {activeTab === "movimentacao" && <MovimentacaoTab />}
      {activeTab === "reportar" && <ReportarTab />}
      {activeTab === "salesops" && isAdmin && <SalesOpsTab />}
    </DashboardLayout>
  );
}

function MovimentacaoTab() {
  const {
    currentUser,
    equipeConfigs,
    loadEquipeConfigs,
    collaborators,
    loadCollaborators,
  } = useAppStore();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [telefone, setTelefone] = useState("");
  const [cpf, setCpf] = useState("");
  const [origem, setOrigem] = useState("");
  const [equipe, setEquipe] = useState("");
  const [assessorId, setAssessorId] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: string } | null>(null);
  const [movements, setMovements] = useState<MovementItem[]>([]);
  const [filterStatus, setFilterStatus] = useState<string>("todos");
  const [filterDataInicio, setFilterDataInicio] = useState(getTodayString());
  const [filterDataFim, setFilterDataFim] = useState(getTodayString());
  const [loadingHistory, setLoadingHistory] = useState(true);
  const isSubmitting = useRef(false);

  const equipesDisponiveis = useMemo(() => {
    if (!equipeConfigs || equipeConfigs.length === 0) return [];
    return equipeConfigs.map(eq => eq.nome).filter(nome => !isExcludedTeam(nome));
  }, [equipeConfigs]);

  useEffect(() => { if (equipeConfigs.length === 0) loadEquipeConfigs(); }, [equipeConfigs, loadEquipeConfigs]);

  const [loadingColaboradores, setLoadingColaboradores] = useState(true);
  useEffect(() => {
    let isMounted = true;
    const carregar = async () => {
      if (collaborators.length === 0) { try { await loadCollaborators(); } catch (error) { console.error("Falha ao carregar colaboradores:", error); } }
      if (isMounted) setLoadingColaboradores(false);
    };
    carregar();
    return () => { isMounted = false; };
  }, []);

  const assessoresDisponiveis = useMemo(() => {
    if (!collaborators.length) return [];
    let filtered = collaborators.filter(c => !isExcludedTeam(c.equipeNome));
    if (equipe) filtered = filtered.filter(c => normalize(c.equipeNome) === normalize(equipe));
    return filtered.map(c => ({
      id: c.id.toString(),
      nome: c.name,
      email: c.email
    }));
  }, [collaborators, equipe]);

  useEffect(() => {
    if (assessorId && !assessoresDisponiveis.find(a => a.id === assessorId)) setAssessorId("");
  }, [assessoresDisponiveis, assessorId]);

  const loadUserHistory = async () => {
    if (!currentUser?.nome) return;
    try {
      const params = new URLSearchParams({ colaborador_origem_nome: currentUser.nome });
      const res = await fetch(`${API_BASE}/suporte/tickets-movimentacao?${params}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Erro ao carregar histórico');
      const data = await res.json();
      if (data.success) {
        const historico: MovementItem[] = (data.data || []).map((ticket: any) => {
          let hubspotData;
          let motivoOriginal = "Registro Concluido";
          let observacao = '';

          if (ticket.observacao_sales_ops) {
            try {
              const parsed = JSON.parse(ticket.observacao_sales_ops);
              if (parsed.hubspot) hubspotData = parsed.hubspot;
              if (parsed.motivoOriginal) motivoOriginal = parsed.motivoOriginal;
              if (parsed.observacao) observacao = parsed.observacao;
            } catch (e) {
              observacao = ticket.observacao_sales_ops;
            }
          }

          return {
            id: `db_${ticket.id_ticket_movimentacao}`,
            timestamp: ticket.criado_em,
            cliente: `${ticket.nome_cliente_informado} ${ticket.sobrenome_cliente_informado}`,
            email: ticket.email_cliente_informado,
            telefone: ticket.telefone_cliente_informado || "Não informado",
            cpf: ticket.cpf_cliente_informado || "Não informado",
            origem: ticket.origem_cliente_informada || "Não informada",
            equipe: ticket.equipe_destino_nome,
            assessor: ticket.colaborador_destino_nome,
            status: ticket.status_mapeamento || "pendente",
            resultado: motivoOriginal,
            usuario: ticket.colaborador_origem_nome,
            atualizadoEm: ticket.criado_em,
            observacao_sales_ops: observacao,
            hubspot: hubspotData,
          };
        });
        setMovements(historico);
      }
    } catch (err: any) {
      console.error('Erro ao carregar histórico:', err);
    } finally {
      setLoadingHistory(false);
    }
  };

  useEffect(() => { loadUserHistory(); }, [currentUser?.nome]);

  // Polling automático a cada 10 segundos enquanto houver tickets pendentes/processando
  useEffect(() => {
    const hasPending = movements.some(
      (m) => m.status === "pendente" || m.status === "processando"
    );

    if (!hasPending) return;

    const intervalId = setInterval(() => {
      loadUserHistory();
    }, 10000);

    return () => clearInterval(intervalId);
  }, [movements]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting.current) return;
    if (!firstName.trim()) { setMessage({ text: "Nome é obrigatório", type: "error" }); return; }
    if (!lastName.trim()) { setMessage({ text: "Sobrenome é obrigatório", type: "error" }); return; }
    if (!telefone.trim()) { setMessage({ text: "Telefone é obrigatório", type: "error" }); return; }

    if (!isValidBrazilianPhone(telefone)) {
      setMessage({ text: "Telefone inválido. Informe DDD + número (ex.: 11 00000-1234).", type: "error" });
      return;
    }

    if (!equipe || !assessorId) { setMessage({ text: "Selecione equipe e assessor", type: "error" }); return; }

    isSubmitting.current = true;
    setLoading(true);
    setMessage(null);

    const assessorSelecionado = assessoresDisponiveis.find(a => a.id === assessorId);
    const assessorNome = assessorSelecionado?.nome || assessorId;
    const assessorEmail = assessorSelecionado?.email || '';

    const idempotencyKey = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });

    const telefoneSemMascara = telefone.replace(/\D/g, '');
    const telefoneCompleto = `+55-${telefoneSemMascara.slice(0, 2)}-${telefoneSemMascara.slice(2, 7)}-${telefoneSemMascara.slice(7)}`;

    const payload = {
      crm_origem: "CRM",
      crm_lead_id: null,
      nome_cliente_informado: firstName.trim(),
      sobrenome_cliente_informado: lastName.trim(),
      email_cliente_informado: email.trim(),
      telefone_cliente_informado: telefoneCompleto,
      cpf_cliente_informado: cpf || null,
      origem_cliente_informada: origem || null,
      tipo_solicitacao: "Movimentação",
      colaborador_origem_nome: currentUser?.nome || currentUser?.email || 'frontend',
      colaborador_origem_email: currentUser?.email || '',
      equipe_origem_nome: currentUser?.equipe || '',
      colaborador_destino_nome: assessorNome,
      colaborador_destino_email: assessorEmail,
      equipe_destino_nome: equipe,
      motivo_solicitacao: null,
      observacao_sales_ops: null,
      status_mapeamento: "pendente",
      idempotency_key: idempotencyKey,
    };

    try {
      const response = await fetch(`${API_BASE}/suporte/ticket-movimentacao`, {
        method: 'POST',
        headers: getCsrfHeaders(),
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `Erro HTTP ${response.status}`);
      }
      const result = await response.json();
      setMessage({ text: result.message || "Solicitação registrada e enfileirada.", type: result.success ? "success" : "error" });
      await loadUserHistory();
      if (result.success) {
        setFirstName(""); setLastName(""); setEmail(""); setTelefone(""); setCpf(""); setOrigem("");
        setEquipe(""); setAssessorId("");
      }
    } catch (err: any) {
      setMessage({ text: err.message || "Erro na movimentação", type: "error" });
      await loadUserHistory();
    } finally {
      setLoading(false);
      setTimeout(() => { isSubmitting.current = false; }, 500);
    }
  };

  const filteredMovements = movements.filter(m => {
    const statusMatch = filterStatus === "todos" || m.status === filterStatus;
    if (!statusMatch) return false;
    return isWithinDateRange(m.timestamp, filterDataInicio, filterDataFim);
  });
  const statusOptions = ["todos", "pendente", "processando", "concluido", "suporte", "aviso", "erro"];

  const exportHistory = () => {
    if (movements.length === 0) return;
    const headers = ["Data/Hora", "Cliente", "E-mail", "Telefone", "CPF", "Equipe", "Assessor", "Status", "HubSpot", "Resultado"];
    const rows = movements.map(m => {
      const hubspotInfo = m.hubspot
        ? m.hubspot.erro
          ? "Erro"
          : m.hubspot.status === 'bloqueado'
            ? m.hubspot.mensagem || "Bloqueado"
            : `${m.hubspot.existe ? "Existe" : "Não existe"}${m.hubspot.pipeline ? ` - ${m.hubspot.pipeline}/${m.hubspot.stage}` : ""}${m.hubspot.status === 'no_pipeline' ? " (no pipeline)" : ""}`
        : "Não verificado";
      return [
        new Date(m.timestamp).toLocaleString("pt-BR"),
        `"${m.cliente}"`,
        `"${m.email}"`,
        `"${m.telefone}"`,
        `"${m.cpf}"`,
        `"${m.equipe}"`,
        `"${m.assessor}"`,
        `"${getStatusInfo(m.status).label}"`,
        `"${hubspotInfo}"`,
        `"${m.resultado}"`,
      ].join(";");
    });
    const csv = [headers.join(";"), ...rows].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `movimentacoes_${new Date().toISOString().split("T")[0]}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const clearHistory = () => {
    if (confirm("Limpar todo o histórico local?")) {
      setMovements([]); setMessage({ text: "Histórico local limpo.", type: "success" });
    }
  };

  return (
    <div className="space-y-6 animate-fade-in-up">
      <div className="card p-5">
        <h2 className="text-lg font-bold text-[#0f172a] mb-4">Movimentação de Leads</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-[#0f172a] mb-1">Nome</label><input type="text" value={firstName} onChange={e => setFirstName(e.target.value)} className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg" required /></div>
            <div><label className="block text-sm font-medium text-[#0f172a] mb-1">Sobrenome</label><input type="text" value={lastName} onChange={e => setLastName(e.target.value)} className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg" required /></div>
            <div><label className="block text-sm font-medium text-[#0f172a] mb-1">E-mail</label><input type="email" value={email} onChange={e => setEmail(e.target.value)} className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg"  /></div>
            <div><label className="block text-sm font-medium text-[#0f172a] mb-1">Origem do Lead</label><select value={origem} onChange={e => setOrigem(e.target.value)} className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg"><option value="">Selecionar origem</option><option value="discadora">Discadora</option><option value="cat">CAT</option><option value="indicacao">Indicação</option><option value="trafego_pago">Marketing</option></select></div>
            <div>
              <label className="block text-sm font-medium text-[#0f172a] mb-1">Telefone</label>
              <div className="flex items-center">
                <span className="px-3 py-2 bg-[#f1f5f9] border border-r-0 border-[#e2e8f0] rounded-l-lg text-sm text-[#64748b]">
                  +55
                </span>
                <input
                  type="tel"
                  value={telefone}
                  onChange={e => setTelefone(formatPhoneInput(e.target.value))}
                  onBlur={() => {
                    if (telefone) {
                      setTelefone(formatPhoneInput(telefone));
                    }
                  }}
                  className="w-full px-3 py-2 border border-[#e2e8f0] rounded-r-lg"
                  placeholder="(00) 00000-0000"
                  required
                />
              </div>
            </div>
            <div><label className="block text-sm font-medium text-[#0f172a] mb-1">CPF</label><input type="text" value={cpf} onChange={e => setCpf(e.target.value)} onBlur={() => cpf && setCpf(formatCPF(cpf))} className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg" /></div>
            <div>
              <label className="block text-sm font-medium text-[#0f172a] mb-1">Equipe Destino *</label>
              <select 
                value={equipe} 
                onChange={e => setEquipe(e.target.value)} 
                className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg" 
                required
              >
                <option value="" disabled>Selecione equipe</option>
                {equipesDisponiveis.map(nome => <option key={nome} value={nome}>{nome}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-[#0f172a] mb-1">Assessor Destino *</label>
              <select 
                value={assessorId} 
                onChange={e => setAssessorId(e.target.value)} 
                className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg" 
                required
              >
                <option value="" disabled>Selecione colaborador</option>
                {loadingColaboradores ? 
                  <option disabled>Carregando...</option> : 
                  assessoresDisponiveis.length === 0 ? 
                    <option disabled>Nenhum disponível</option> : 
                    assessoresDisponiveis.map(a => <option key={a.id} value={a.id}>{a.nome}</option>)
                }
              </select>
            </div>
          </div>
          {message && <div className={cn("p-3 rounded-lg text-sm", message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700")} role="status">{message.text}</div>}
          <div className="flex justify-end"><button type="submit" disabled={loading || loadingColaboradores} className="bg-[#2F6FED] text-white px-6 py-2 rounded-lg font-semibold flex items-center gap-2 hover:bg-[#2F6FED]/90 transition-colors disabled:opacity-50">{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}{loading ? "Enviando..." : "Registrar Movimentação"}</button></div>
        </form>
      </div>

      {/* Histórico */}
      <div className="card p-5">
        <div className="flex flex-wrap justify-between items-center mb-4 gap-2">
          <h2 className="text-lg font-bold text-[#0f172a]">Histórico</h2>
          <div className="flex flex-wrap items-center gap-2">
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="px-2 py-1 border border-[#e2e8f0] rounded text-sm">
              {statusOptions.map(s => <option key={s} value={s}>{s === "todos" ? "Todos" : s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
            <input
              type="date"
              value={filterDataInicio}
              onChange={e => setFilterDataInicio(e.target.value)}
              className="px-2 py-1 border border-[#e2e8f0] rounded text-sm"
              title="Data inicial"
            />
            <span className="text-sm text-[#64748b]">até</span>
            <input
              type="date"
              value={filterDataFim}
              onChange={e => setFilterDataFim(e.target.value)}
              className="px-2 py-1 border border-[#e2e8f0] rounded text-sm"
              title="Data final"
            />
            <button onClick={exportHistory} className="text-sm bg-[#f1f5f9] px-3 py-1 rounded flex items-center gap-1 hover:bg-[#e2e8f0]"><Download className="w-3 h-3" /> Exportar</button>
            <button onClick={clearHistory} className="text-sm bg-red-50 text-red-700 px-3 py-1 rounded flex items-center gap-1 hover:bg-red-100"><X className="w-3 h-3" /> Limpar</button>
          </div>
        </div>
        {loadingHistory ? <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-[#2F6FED]" /></div> :
          filteredMovements.length === 0 ? <div className="text-center py-8 text-[#64748b]">Nenhuma movimentação registrada no período</div> :
          <div className="overflow-x-auto">
            <table className="simple-table">
              <thead><tr><th>Data/Hora</th><th>Cliente</th><th>E-mail</th><th>Contato</th><th>Equipe/Assessor</th><th>Status</th><th>Obs. SalesOps</th><th>Resultado</th></tr></thead>
              <tbody>{filteredMovements.map(m => {
                const statusParaExibir = m.status;
                const info = getStatusInfo(statusParaExibir);
                return (
                  <tr key={m.id}>
                    <td className="whitespace-nowrap">{new Date(m.timestamp).toLocaleString("pt-BR")}</td>
                    <td>{m.cliente}</td>
                    <td>{m.email}</td>
                    <td><div>{m.telefone}</div><small className="text-[#94a3b8]">{m.cpf}</small></td>
                    <td><div>{m.equipe}</div><small>{m.assessor}</small></td>
                    <td>
                      <span className={cn("badge", info.className)} title={m.hubspot?.mensagem || info.label}>
                        {info.icon} {info.label}
                      </span>
                    </td>
                    <td className="max-w-[200px] whitespace-pre-wrap break-words" title={m.observacao_sales_ops || ''}>
                      {m.observacao_sales_ops || '—'}
                    </td>
                    <td className="max-w-xs whitespace-pre-wrap break-words">{m.resultado}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>}
      </div>
    </div>
  );
}

// ---------------------- Aba Reportar ----------------------
function ReportarTab() {
  const { currentUser } = useAppStore();

  const [titulo, setTitulo] = useState("");
  const [assunto, setAssunto] = useState("");
  const [descricao, setDescricao] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: string } | null>(null);
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [filterStatus, setFilterStatus] = useState<string>("todos");
  const [filterDataInicio, setFilterDataInicio] = useState(getTodayString());
  const [filterDataFim, setFilterDataFim] = useState(getTodayString());
  const [loadingReports, setLoadingReports] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadUserReports = async () => {
    if (!currentUser?.email) {
      setLoadingReports(false);
      return;
    }
    try {
      setLoadingReports(true);
      setLoadError(null);
      const res = await fetch(
        `${API_BASE}/suporte/ticket-suporte?solicitante_email=${encodeURIComponent(currentUser.email)}`,
        { credentials: 'include' }
      );
      if (!res.ok) throw new Error(`Erro ${res.status}: ${res.statusText}`);
      const data = await res.json();
      if (data.success && Array.isArray(data.data)) {
        const mapped: ReportItem[] = data.data.map((ticket: any) => ({
          id: `REP_${ticket.id_ticket_suporte}`,
          data: ticket.criado_em,
          titulo: ticket.titulo || ticket.assunto || '',
          assunto: ticket.assunto || ticket.titulo || '',
          descricao: ticket.descricao || '',
          descricaoResumida: ticket.descricao
            ? ticket.descricao.length > 200
              ? ticket.descricao.substring(0, 200) + "..."
              : ticket.descricao
            : '',
          solicitante: ticket.solicitante_nome,
          equipe: ticket.equipe_nome,
          status: ticket.status || "ENVIADO",
          observacao_sales_ops: ticket.observacao_sales_ops || '',
          ultimaAtualizacao: ticket.criado_em,
        }));
        setReports(mapped);
      } else {
        setLoadError('Formato de resposta inesperado da API.');
      }
    } catch (err: any) {
      console.error('Erro ao carregar reportes:', err);
      setLoadError(err.message || 'Erro desconhecido ao carregar reportes.');
    } finally {
      setLoadingReports(false);
    }
  };

  useEffect(() => {
    if (currentUser?.email) {
      loadUserReports();
    } else {
      setLoadingReports(false);
    }
  }, [currentUser?.email]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!titulo.trim()) { setMessage({ text: "Preencha o título", type: "error" }); return; }
    if (!assunto || !descricao.trim()) { setMessage({ text: "Preencha assunto e descrição", type: "error" }); return; }
    if (descricao.replace(/\n/g, "").length < 10) { setMessage({ text: "Descrição muito curta", type: "error" }); return; }
    if (files.length === 0) { setMessage({ text: "Necessário 1 print para o envio", type: "error" }); return; }

    setLoading(true);
    setMessage(null);

    try {
      const formData = new FormData();
      formData.append('titulo', titulo.trim());
      formData.append('assunto', assunto);
      formData.append('descricao', descricao);
      formData.append('solicitante_nome', currentUser?.nome || '');
      formData.append('solicitante_email', currentUser?.email || '');
      formData.append('equipe_nome', currentUser?.equipe || '');

      files.forEach((file) => {
        formData.append('arquivos', file, file.name);
      });

      const res = await fetch(`${API_BASE}/suporte/ticket-suporte`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'x-csrf-token': localStorage.getItem('csrfToken') || '',
        },
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao registrar ticket');

      setMessage({ text: "Reporte registado com sucesso.", type: "success" });
      setTitulo("");
      setAssunto("");
      setDescricao("");
      setFiles([]);
      const fileInput = document.getElementById("reportar-arquivos") as HTMLInputElement;
      if (fileInput) fileInput.value = "";

      await loadUserReports();
    } catch (err: any) {
      setMessage({ text: err.message, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) setFiles(Array.from(e.target.files));
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const newFiles = Array.from(e.dataTransfer.files);
      setFiles(prev => [...prev, ...newFiles]);
      e.dataTransfer.clearData();
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const cancelRequest = async (id: string) => {
    if (!confirm("Tem certeza que deseja cancelar esta solicitação?")) return;
    try {
      const numericId = id.replace("REP_", "");
      const res = await fetch(`${API_BASE}/suporte/tickets-suporte/${numericId}`, {
        method: 'PATCH',
        headers: getCsrfHeaders(),
        credentials: 'include',
        body: JSON.stringify({ status: 'CANCELADO' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao cancelar solicitação');
      setMessage({ text: "Solicitação cancelada com sucesso.", type: "success" });
      await loadUserReports();
    } catch (err: any) {
      setMessage({ text: err.message, type: "error" });
    }
  };

  const exportReports = () => {
    if (reports.length === 0) return;
    const headers = ["Data", "Título", "Assunto", "Status", "Solicitante", "Equipe", "Obs. SalesOps"];
    const rows = reports.map(r =>
      [new Date(r.data).toLocaleString("pt-BR"), `"${r.titulo}"`, `"${r.assunto}"`, r.status, `"${r.solicitante}"`, `"${r.equipe}"`, `"${r.observacao_sales_ops}"`].join(";")
    );
    const csv = [headers.join(";"), ...rows].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `reportes_${new Date().toISOString().split("T")[0]}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const filteredReports = reports.filter(r => {
    const statusMatch = filterStatus === "todos" || r.status === filterStatus;
    if (!statusMatch) return false;
    return isWithinDateRange(r.data, filterDataInicio, filterDataFim);
  });
  const statusOptions = ["todos", "ENVIADO", "SUSPEITO", "CONCLUÍDO", "ERRO", "BLOQUEADO", "ANALISE", "REVISÃO", "CANCELADO"];

  const viewDetails = (report: ReportItem) => {
    const statusLabel = getStatusInfo(report.status).label;
    const dataFormatada = new Date(report.data).toLocaleString("pt-BR");
    const detalhes = `
Título: ${report.titulo}
Assunto: ${report.assunto}
Solicitante: ${report.solicitante || "Não informado"}
Equipe: ${report.equipe || "Não informada"}
Data de criação: ${dataFormatada}
Status: ${statusLabel}
${report.descricao ? `\nDescrição:\n${report.descricao}` : ""}
${report.observacao_sales_ops ? `\nObs. SalesOps:\n${report.observacao_sales_ops}` : ""}
`.trim();
    alert(detalhes);
  };

  return (
    <div className="space-y-6 animate-fade-in-up">
      <div className="card p-5">
        <h2 className="text-lg font-bold text-[#0f172a] mb-4">Reportar Problema</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="rep-titulo" className="block text-sm font-medium text-[#0f172a] mb-1">Título *</label>
            <input
              type="text"
              id="rep-titulo"
              value={titulo}
              onChange={e => setTitulo(e.target.value)}
              className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg"
              placeholder="Ex.: Erro ao carregar relatório"
              required
              maxLength={150}
            />
          </div>

          <div>
            <label htmlFor="rep-assunto" className="block text-sm font-medium text-[#0f172a] mb-1">Assunto</label>
            <select id="rep-assunto" value={assunto} onChange={e => setAssunto(e.target.value)} className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg" required>
              <option value="">Selecionar assunto</option>
              <option value="Discadora">Discadora</option>
              <option value="CRM">CRM</option>
              <option value="Dash">Dash</option>
              <option value="Acesso">Acessos</option>
              <option value="Reversao">Reversão</option>
              <option value="Outro">Outro</option>
            </select>
          </div>

          <div>
            <label htmlFor="rep-descricao" className="block text-sm font-medium text-[#0f172a] mb-1">Descrição</label>
            <textarea id="rep-descricao" value={descricao} onChange={e => setDescricao(e.target.value)} rows={5} className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg" required />
            <div className="text-right text-xs text-[#94a3b8] mt-1">{descricao.length}/1000</div>
          </div>

          <div>
            <span className="block text-sm font-medium text-[#0f172a] mb-1">
              Anexos <span className="text-red-500">*</span> <span className="text-xs text-[#64748b]">(obrigatório pelo menos 1 print)</span>
            </span>
            
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => document.getElementById('reportar-arquivos')?.click()}
              className={cn(
                "flex flex-col items-center justify-center border-2 border-dashed rounded-lg p-6 cursor-pointer transition-colors",
                isDragging ? "border-[#2F6FED] bg-[#eff6ff]" : "border-[#cbd5e1] bg-[#f8fafc] hover:border-[#2F6FED] hover:bg-[#f0f7ff]"
              )}
            >
              <Upload className={cn("w-8 h-8 mb-2", isDragging ? "text-[#2F6FED]" : "text-[#94a3b8]")} />
              <p className="text-sm text-[#475569]">
                <span className="font-semibold text-[#2F6FED]">Clique para anexar</span> ou arraste os arquivos aqui
              </p>
              <p className="text-xs text-[#94a3b8] mt-1">PNG, JPG, PDF, DOC, XLS, ZIP (máx. 10 MB por arquivo)</p>
            </div>

            <input
              type="file"
              id="reportar-arquivos"
              multiple
              onChange={handleFileChange}
              className="hidden"
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt,.zip"
            />

            {files.length > 0 && (
              <ul className="mt-3 space-y-2">
                {files.map((f, idx) => (
                  <li key={idx} className="flex items-center justify-between bg-white border border-[#e2e8f0] rounded-lg p-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Paperclip className="w-4 h-4 text-[#64748b] flex-shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm text-[#0f172a] truncate">{f.name}</p>
                        <p className="text-xs text-[#94a3b8]">{(f.size / 1024).toFixed(0)} KB</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFile(idx);
                      }}
                      className="p-1 rounded hover:bg-red-50 text-red-500 hover:text-red-700 flex-shrink-0"
                      title="Remover arquivo"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {message && (
            <div className={cn("p-3 rounded-lg text-sm", message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700")} role="status">
              {message.text}
            </div>
          )}

          <div className="flex justify-end">
            <button type="submit" disabled={loading} className="bg-[#2F6FED] text-white px-6 py-2 rounded-lg font-semibold flex items-center gap-2 hover:bg-[#2F6FED]/90 transition-colors disabled:opacity-50">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              {loading ? "Enviando..." : "Enviar Reporte"}
            </button>
          </div>
        </form>
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap justify-between items-center mb-4 gap-2">
          <h2 className="text-lg font-bold text-[#0f172a]">Meus Reportes</h2>
          <div className="flex flex-wrap items-center gap-2">
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="px-2 py-1 border border-[#e2e8f0] rounded text-sm">
              {statusOptions.map(s => <option key={s} value={s}>{s === "todos" ? "Todos" : s}</option>)}
            </select>
            <input
              type="date"
              value={filterDataInicio}
              onChange={e => setFilterDataInicio(e.target.value)}
              className="px-2 py-1 border border-[#e2e8f0] rounded text-sm"
              title="Data inicial"
            />
            <span className="text-sm text-[#64748b]">até</span>
            <input
              type="date"
              value={filterDataFim}
              onChange={e => setFilterDataFim(e.target.value)}
              className="px-2 py-1 border border-[#e2e8f0] rounded text-sm"
              title="Data final"
            />
            <button type="button" onClick={exportReports} className="text-sm bg-[#f1f5f9] px-3 py-1 rounded flex items-center gap-1 hover:bg-[#e2e8f0]">
              <Download className="w-3 h-3" /> Exportar
            </button>
          </div>
        </div>
        {loadError && (
          <div className="p-3 rounded-lg text-sm bg-red-50 text-red-700 mb-4">
            Erro ao carregar reportes: {loadError}
          </div>
        )}
        {loadingReports ? (
          <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-[#2F6FED]" /></div>
        ) : filteredReports.length === 0 ? (
          <div className="text-center py-8 text-[#64748b]">Nenhum reporte encontrado no período</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Título</th>
                  <th>Obs. SalesOps</th>
                  <th>Status</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredReports.map(r => {
                  const info = getStatusInfo(r.status);
                  const canCancel = r.status === "ENVIADO" || r.status === "REVISÃO";
                  return (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap">{new Date(r.data).toLocaleString("pt-BR")}</td>
                      <td>
                        <div>{r.titulo}</div>
                        {r.assunto && r.assunto !== r.titulo && <small className="text-[#94a3b8]">{r.assunto}</small>}
                      </td>
                      <td className="max-w-[200px] whitespace-pre-wrap break-words" title={r.observacao_sales_ops}>
                        {r.observacao_sales_ops || "—"}
                      </td>
                      <td><span className={cn("badge", info.className)}>{info.icon} {info.label}</span></td>
                      <td>
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => viewDetails(r)} className="text-[#2F6FED] hover:text-[#2F6FED]/80" title="Ver detalhes">
                            <Eye className="w-4 h-4" />
                          </button>
                          {canCancel && (
                            <button
                              type="button"
                              onClick={() => cancelRequest(r.id)}
                              className="text-red-500 hover:text-red-700"
                              title="Cancelar solicitação"
                            >
                              <Ban className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------- Visão SalesOps ----------------------
function SalesOpsTab() {
  const [subTab, setSubTab] = useState<"movimentacoes" | "reportes">("reportes");

  return (
    <div className="space-y-4">
      <div className="flex gap-2 border-b border-[#e2e8f0] pb-2">
        {[
          { id: "reportes", label: "Reportes" },
          { id: "movimentacoes", label: "Movimentações" },         
        ].map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setSubTab(tab.id as typeof subTab)}
            className={cn(
              "filter-pill",
              subTab === tab.id && "active"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {subTab === "movimentacoes" && <MovimentacoesSuporteTab />}
      {subTab === "reportes" && <ReportesSuporteTab />}
    </div>
  );
}

// ---------------------- Modal de Edição (Reutilizável) ----------------------
interface EditModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  onSave: () => void;
  saving: boolean;
}

function EditModal({ isOpen, onClose, title, children, onSave, saving }: EditModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold text-[#0f172a]">{title}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="space-y-4">
          {children}
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-[#e2e8f0] rounded-lg text-sm font-medium text-[#475569] hover:bg-[#f1f5f9]"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="px-4 py-2 bg-[#2F6FED] text-white rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-[#2F6FED]/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------- Tabela de movimentações com edição via modal ----------------------
function MovimentacoesSuporteTab() {
  const [tickets, setTickets] = useState<TicketMovimentacao[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ text: string; type: string } | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("todos");
  const [filterDataInicio, setFilterDataInicio] = useState(getTodayString());
  const [filterDataFim, setFilterDataFim] = useState(getTodayString());
  const [editingTicket, setEditingTicket] = useState<TicketMovimentacao | null>(null);
  const [editForm, setEditForm] = useState<{ status_mapeamento: string; observacao_sales_ops: string }>({ status_mapeamento: '', observacao_sales_ops: '' });
  const [saving, setSaving] = useState(false);
  const [showConcluidos, setShowConcluidos] = useState(false);

  const carregarTickets = async () => {
    try {
      const res = await fetch(`${API_BASE}/suporte/tickets-movimentacao?todos=1`, { credentials: 'include' });
      const data = await res.json();
      if (data.success) setTickets(data.data);
      else setMessage({ text: "Erro ao carregar tickets", type: "error" });
    } catch (err) {
      setMessage({ text: "Erro ao carregar tickets", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    carregarTickets();
  }, []);

  const openEditModal = (ticket: TicketMovimentacao) => {
    setEditingTicket(ticket);
    let observacao = ticket.observacao_sales_ops || '';
    try {
      const parsed = JSON.parse(observacao);
      observacao = parsed.observacao || observacao;
    } catch (e) {
      // Mantém texto puro
    }
    setEditForm({
      status_mapeamento: ticket.status_mapeamento || 'pendente',
      observacao_sales_ops: observacao,
    });
  };

  const closeEditModal = () => {
    setEditingTicket(null);
    setEditForm({ status_mapeamento: '', observacao_sales_ops: '' });
  };

  const saveEdit = async () => {
    if (!editingTicket) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/suporte/tickets-movimentacao/${editingTicket.id_ticket_movimentacao}`, {
        method: 'PATCH',
        headers: getCsrfHeaders(),
        credentials: 'include',
        body: JSON.stringify({
          status_mapeamento: editForm.status_mapeamento,
          observacao_sales_ops: editForm.observacao_sales_ops,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao atualizar');

      setTickets(prev => prev.map(t => {
        if (t.id_ticket_movimentacao !== editingTicket.id_ticket_movimentacao) return t;
        let novoObservacao;
        try {
          const current = JSON.parse(t.observacao_sales_ops || '{}');
          current.observacao = editForm.observacao_sales_ops;
          novoObservacao = JSON.stringify(current);
        } catch {
          novoObservacao = JSON.stringify({ observacao: editForm.observacao_sales_ops });
        }
        return {
          ...t,
          status_mapeamento: editForm.status_mapeamento,
          observacao_sales_ops: novoObservacao,
        };
      }));

      setMessage({ text: "Ticket atualizado com sucesso.", type: "success" });
      closeEditModal();
    } catch (err: any) {
      setMessage({ text: err.message, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const filteredTickets = tickets.filter(t => {
    const statusMatch = filterStatus === "todos" || t.status_mapeamento === filterStatus;
    if (!statusMatch) return false;
    if (!showConcluidos && t.status_mapeamento === 'concluido') return false;
    return isWithinDateRange(t.criado_em, filterDataInicio, filterDataFim);
  });

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-[#2F6FED]" /></div>;

  return (
    <div className="space-y-4">
      {message && <div className={cn("p-3 rounded-lg text-sm", message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700")}>{message.text}</div>}
      <div className="card p-5">
        <div className="flex flex-wrap justify-between items-center mb-4 gap-2">
          <h2 className="text-lg font-bold text-[#0f172a]">Movimentações (Suporte)</h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowConcluidos(!showConcluidos)}
              className={cn(
                "px-3 py-1 rounded text-sm flex items-center gap-1 transition-colors",
                showConcluidos
                  ? "bg-[#2F6FED] text-white hover:bg-[#2F6FED]/90"
                  : "bg-[#f1f5f9] text-[#475569] hover:bg-[#e2e8f0]"
              )}
            >
              {showConcluidos ? (
                <>
                  <Eye className="w-3 h-3" /> Ocultar concluídos
                </>
              ) : (
                <>
                  <Eye className="w-3 h-3" /> Mostrar concluídos
                </>
              )}
            </button>

            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="px-2 py-1 border border-[#e2e8f0] rounded text-sm"
              title="Filtrar por status"
            >
              <option value="todos">Todos</option>
              <option value="pendente">Pendente</option>
              <option value="processando">Processando</option>
              <option value="concluido">Concluído</option>
              <option value="suporte">Suporte</option>
              <option value="aviso">Aviso</option>
              <option value="erro">Erro</option>
            </select>

            <input
              type="date"
              value={filterDataInicio}
              onChange={e => setFilterDataInicio(e.target.value)}
              className="px-2 py-1 border border-[#e2e8f0] rounded text-sm"
              title="Data inicial"
            />
            <span className="text-sm text-[#64748b]">até</span>
            <input
              type="date"
              value={filterDataFim}
              onChange={e => setFilterDataFim(e.target.value)}
              className="px-2 py-1 border border-[#e2e8f0] rounded text-sm"
              title="Data final"
            />
          </div>
        </div>

        {filteredTickets.length === 0 ? (
          <div className="text-center py-8 text-[#64748b]">Nenhum ticket de movimentação encontrado</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Data</th>
                  <th>Solicitante</th>
                  <th>Cliente</th>
                  <th>Contato</th>
                  <th>Origem</th>
                  <th>Destino</th>
                  <th>Status</th>
                  <th>Obs.</th>
                  <th className="w-20">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredTickets.map(ticket => {
                  const statusInfo = getStatusInfo(ticket.status_mapeamento || 'pendente');
                  return (
                    <tr key={ticket.id_ticket_movimentacao}>
                      <td>{ticket.id_ticket_movimentacao}</td>
                      <td className="whitespace-nowrap">{new Date(ticket.criado_em).toLocaleDateString('pt-BR')}</td>
                      <td>{ticket.colaborador_origem_nome}</td>
                      <td>{`${ticket.nome_cliente_informado} ${ticket.sobrenome_cliente_informado}`}</td>
                      <td>
                        <div>{ticket.telefone_cliente_informado || "—"}</div>
                        <small className="text-[#94a3b8]">{ticket.cpf_cliente_informado || "—"}</small>
                      </td>
                      <td>{ticket.equipe_origem_nome}</td>
                      <td>{ticket.equipe_destino_nome} / {ticket.colaborador_destino_nome}</td>
                      <td>
                        <span className={cn("badge", statusInfo.className)}>
                          {statusInfo.icon} {statusInfo.label}
                        </span>
                      </td>
                      <td className="max-w-[200px]">
                        <span className="block whitespace-pre-wrap break-words" title={ticket.observacao_sales_ops}>
                          {(() => {
                            try {
                              const parsed = JSON.parse(ticket.observacao_sales_ops || '{}');
                              return parsed.observacao || ticket.observacao_sales_ops || '—';
                            } catch {
                              return ticket.observacao_sales_ops || '—';
                            }
                          })()}
                        </span>
                      </td>
                      <td>
                        <button
                          onClick={() => openEditModal(ticket)}
                          className="p-2 rounded-lg hover:bg-[#f1f5f9] text-[#64748b] hover:text-[#2F6FED] transition-colors"
                          title="Editar"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <EditModal
        isOpen={editingTicket !== null}
        onClose={closeEditModal}
        title={`Editar Movimentação #${editingTicket?.id_ticket_movimentacao || ''}`}
        onSave={saveEdit}
        saving={saving}
      >
        <div>
          <label className="block text-sm font-medium text-[#0f172a] mb-2">Status</label>
          <select
            value={editForm.status_mapeamento}
            onChange={e => setEditForm(prev => ({ ...prev, status_mapeamento: e.target.value }))}
            className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg text-sm"
          >
            <option value="pendente">Pendente</option>
            <option value="processando">Processando</option>
            <option value="concluido">Concluído</option>
            <option value="suporte">Suporte</option>
            <option value="aviso">Aviso</option>
            <option value="erro">Erro</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-[#0f172a] mb-2">Observação SalesOps</label>
          <textarea
            value={editForm.observacao_sales_ops}
            onChange={e => setEditForm(prev => ({ ...prev, observacao_sales_ops: e.target.value }))}
            rows={5}
            className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg text-sm resize-none"
            placeholder="Digite a observação..."
          />
        </div>
      </EditModal>
    </div>
  );
}

// ---------------------- Tabela de reportes com edição via modal (SalesOps) ----------------------
function ReportesSuporteTab() {
  const [tickets, setTickets] = useState<TicketSuporte[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ text: string; type: string } | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("todos");
  const [filterAssunto, setFilterAssunto] = useState<string>("todos");
  const [filterDataInicio, setFilterDataInicio] = useState(getTodayString());
  const [filterDataFim, setFilterDataFim] = useState(getTodayString());
  const [editingTicket, setEditingTicket] = useState<TicketSuporte | null>(null);
  const [editForm, setEditForm] = useState<{ status: string; observacao_sales_ops: string }>({ status: '', observacao_sales_ops: '' });
  const [saving, setSaving] = useState(false);

  const carregarReportes = async () => {
    try {
      const res = await fetch(`${API_BASE}/suporte/ticket-suporte?todos=1`, { credentials: 'include' });
      const data = await res.json();
      if (data.success) setTickets(data.data);
      else setMessage({ text: "Erro ao carregar reportes", type: "error" });
    } catch (err) {
      setMessage({ text: "Erro ao carregar reportes", type: "error" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    carregarReportes();
  }, []);

  const assuntosDisponiveis = useMemo(() => {
    const assuntos = tickets.map(t => t.assunto).filter(Boolean);
    return Array.from(new Set(assuntos)).sort();
  }, [tickets]);

  const openEditModal = (ticket: TicketSuporte) => {
    setEditingTicket(ticket);
    setEditForm({
      status: ticket.status || 'ENVIADO',
      observacao_sales_ops: ticket.observacao_sales_ops || '',
    });
  };

  const closeEditModal = () => {
    setEditingTicket(null);
    setEditForm({ status: '', observacao_sales_ops: '' });
  };

  const saveEdit = async () => {
    if (!editingTicket) return;
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE}/suporte/tickets-suporte/${editingTicket.id_ticket_suporte}`, {
        method: 'PATCH',
        headers: getCsrfHeaders(),
        credentials: 'include',
        body: JSON.stringify(editForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Erro ao atualizar');

      setTickets(prev => prev.map(t => t.id_ticket_suporte === editingTicket.id_ticket_suporte ? { ...t, status: editForm.status, observacao_sales_ops: editForm.observacao_sales_ops } : t));
      setMessage({ text: "Reporte atualizado com sucesso.", type: "success" });
      closeEditModal();
    } catch (err: any) {
      setMessage({ text: err.message, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const filteredTickets = tickets.filter(t => {
    const statusMatch = filterStatus === "todos" || t.status === filterStatus;
    const assuntoMatch = filterAssunto === "todos" || t.assunto === filterAssunto;
    if (!statusMatch || !assuntoMatch) return false;
    return isWithinDateRange(t.criado_em, filterDataInicio, filterDataFim);
  });

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-[#2F6FED]" /></div>;

  return (
    <div className="space-y-4">
      {message && <div className={cn("p-3 rounded-lg text-sm", message.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700")}>{message.text}</div>}
      <div className="card p-5">
        <div className="flex flex-wrap justify-between items-center mb-4 gap-2">
          <h2 className="text-lg font-bold text-[#0f172a]">Reportes (Suporte)</h2>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filterAssunto}
              onChange={e => setFilterAssunto(e.target.value)}
              className="px-2 py-1 border border-[#e2e8f0] rounded text-sm"
              title="Filtrar por assunto"
            >
              <option value="todos">Todos os assuntos</option>
              {assuntosDisponiveis.map(assunto => (
                <option key={assunto} value={assunto}>{assunto}</option>
              ))}
            </select>

            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="px-2 py-1 border border-[#e2e8f0] rounded text-sm"
              title="Filtrar por status"
            >
              <option value="todos">Todos</option>
              <option value="ENVIADO">Enviado</option>
              <option value="SUSPEITO">Suspeito</option>
              <option value="CONCLUÍDO">Concluído</option>
              <option value="ERRO">Erro</option>
              <option value="BLOQUEADO">Bloqueado</option>
              <option value="ANALISE">Análise</option>
              <option value="REVISÃO">Revisão</option>
              <option value="CANCELADO">Cancelado</option>
            </select>

            <input
              type="date"
              value={filterDataInicio}
              onChange={e => setFilterDataInicio(e.target.value)}
              className="px-2 py-1 border border-[#e2e8f0] rounded text-sm"
              title="Data inicial"
            />
            <span className="text-sm text-[#64748b]">até</span>
            <input
              type="date"
              value={filterDataFim}
              onChange={e => setFilterDataFim(e.target.value)}
              className="px-2 py-1 border border-[#e2e8f0] rounded text-sm"
              title="Data final"
            />
          </div>
        </div>

        {filteredTickets.length === 0 ? (
          <div className="text-center py-8 text-[#64748b]">Nenhum reporte encontrado</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="simple-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Data</th>
                  <th>Solicitante</th>
                  <th>Equipe</th>
                  <th>Título</th>
                  <th>Status</th>
                  <th>Obs. SalesOps</th>
                  <th className="w-20">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredTickets.map(ticket => {
                  const statusInfo = getStatusInfo(ticket.status || 'ENVIADO');
                  return (
                    <tr key={ticket.id_ticket_suporte}>
                      <td>{ticket.id_ticket_suporte}</td>
                      <td className="whitespace-nowrap">{new Date(ticket.criado_em).toLocaleDateString('pt-BR')}</td>
                      <td>{ticket.solicitante_nome}</td>
                      <td>{ticket.equipe_nome}</td>
                      <td>{ticket.titulo || ticket.assunto}</td>
                      <td>
                        <span className={cn("badge", statusInfo.className)}>
                          {statusInfo.icon} {statusInfo.label}
                        </span>
                      </td>
                      <td className="max-w-[200px]">
                        <span className="block whitespace-pre-wrap break-words" title={ticket.observacao_sales_ops}>
                          {ticket.observacao_sales_ops || "—"}
                        </span>
                      </td>
                      <td>
                        <button
                          onClick={() => openEditModal(ticket)}
                          className="p-2 rounded-lg hover:bg-[#f1f5f9] text-[#64748b] hover:text-[#2F6FED] transition-colors"
                          title="Editar"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <EditModal
        isOpen={editingTicket !== null}
        onClose={closeEditModal}
        title={`Editar Reporte #${editingTicket?.id_ticket_suporte || ''}`}
        onSave={saveEdit}
        saving={saving}
      >
        <div>
          <label className="block text-sm font-medium text-[#0f172a] mb-2">Status</label>
          <select
            value={editForm.status}
            onChange={e => setEditForm(prev => ({ ...prev, status: e.target.value }))}
            className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg text-sm"
          >
            <option value="ENVIADO">Enviado</option>
            <option value="SUSPEITO">Suspeito</option>
            <option value="CONCLUÍDO">Concluído</option>
            <option value="ERRO">Erro</option>
            <option value="BLOQUEADO">Bloqueado</option>
            <option value="ANALISE">Análise</option>
            <option value="REVISÃO">Revisão</option>
            <option value="CANCELADO">Cancelado</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-[#0f172a] mb-2">Observação SalesOps</label>
          <textarea
            value={editForm.observacao_sales_ops}
            onChange={e => setEditForm(prev => ({ ...prev, observacao_sales_ops: e.target.value }))}
            rows={5}
            className="w-full px-3 py-2 border border-[#e2e8f0] rounded-lg text-sm resize-none"
            placeholder="Digite a observação..."
          />
        </div>
      </EditModal>
    </div>
  );
}