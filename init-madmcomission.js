// init-madmcomission.js
const { spawn } = require('child_process');
const path = require('path');

// Cores para console
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m'
};

console.log(`${colors.bright}${colors.blue}🚀 MADM Comissionamento - Inicializando sistemas...${colors.reset}\n`);

// Configurações
const BACKEND_DIR = path.join(__dirname, 'backend');
const FRONTEND_DIR = path.join(__dirname, 'frontend');
const BACKEND_CMD = 'node';
const BACKEND_ARGS = ['server.js'];
const FRONTEND_CMD = 'npm';
const FRONTEND_ARGS = ['run', 'dev'];

// Processos
let backendProcess = null;
let frontendProcess = null;

// Função para iniciar backend
function startBackend() {
  console.log(`${colors.yellow}📦 Iniciando backend...${colors.reset}`);
  backendProcess = spawn(BACKEND_CMD, BACKEND_ARGS, {
    cwd: BACKEND_DIR,
    stdio: 'pipe',
    shell: true
  });

  backendProcess.stdout.on('data', (data) => {
    console.log(`${colors.green}[BACKEND]${colors.reset} ${data.toString().trim()}`);
  });

  backendProcess.stderr.on('data', (data) => {
    console.error(`${colors.red}[BACKEND ERROR]${colors.reset} ${data.toString().trim()}`);
  });

  backendProcess.on('close', (code) => {
    if (code !== 0) {
      console.error(`${colors.red}❌ Backend encerrou com código ${code}${colors.reset}`);
    }
  });
} 

// Função para iniciar frontend
function startFrontend() {
  console.log(`${colors.yellow}🎨 Iniciando frontend...${colors.reset}`);
  frontendProcess = spawn(FRONTEND_CMD, FRONTEND_ARGS, {
    cwd: FRONTEND_DIR,
    stdio: 'pipe',
    shell: true
  });

  frontendProcess.stdout.on('data', (data) => {
    console.log(`${colors.blue}[FRONTEND]${colors.reset} ${data.toString().trim()}`);
  });

  frontendProcess.stderr.on('data', (data) => {
    console.error(`${colors.red}[FRONTEND ERROR]${colors.reset} ${data.toString().trim()}`);
  });

  frontendProcess.on('close', (code) => {
    if (code !== 0) {
      console.error(`${colors.red}❌ Frontend encerrou com código ${code}${colors.reset}`);
    }
  });
}

// Encerrar todos os processos ao receber Ctrl+C
function shutdown() {
  console.log(`\n${colors.bright}${colors.yellow}🛑 Encerrando processos...${colors.reset}`);
  if (backendProcess) backendProcess.kill();
  if (frontendProcess) frontendProcess.kill();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Iniciar serviços
startBackend();
setTimeout(() => {
  startFrontend();
}, 2000); // Pequeno delay para garantir que o backend iniciou primeiro

console.log(`${colors.bright}${colors.green}✅ Servidores iniciando. Aguarde alguns segundos...${colors.reset}`);
console.log(`${colors.bright}🌐 Backend: http://localhost:3007${colors.reset}`);
console.log(`${colors.bright}🌐 Frontend: http://localhost:3008${colors.reset}`);
console.log(`${colors.bright}⚠️  Pressione Ctrl+C para encerrar ambos os servidores.${colors.reset}\n`);