// backend/routes/notificacoes.js
import express from 'express';

const router = express.Router();

// Conjunto de conexões SSE ativas
const sseClients = new Set();

/**
 * Envia uma notificação para todos os clientes conectados.
 * A notificação pode incluir um campo `destinatario` (email) para restringir a exibição no frontend.
 *
 * @param {Object} notification - Objeto com { tipo, titulo, mensagem, destinatario?, data }
 */
export function broadcastNotification(notification) {
  const data = `data: ${JSON.stringify(notification)}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
}

/**
 * Endpoint SSE – os clientes se conectam aqui para receber notificações em tempo real.
 * Rota: GET /api/notificacoes/stream
 */
router.get('/stream', (req, res) => {
  // Cabeçalhos obrigatórios para SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Envia um comentário inicial para estabelecer a conexão
  res.write(': connected\n\n');

  // Adiciona a conexão ao conjunto
  sseClients.add(res);

  // Remove a conexão quando o cliente desconectar
  req.on('close', () => {
    sseClients.delete(res);
  });
});

export default router;