// backend/security/index.js
import { inputSanitizer } from './input-validator.js';
import { fullScan } from './scanners/total-security.js';

export function securityMiddleware(req, res, next) {
  // Sanitiza req.body, req.query e req.params
  inputSanitizer(req, res, () => {
    // Após sanitização, verifica se restaram padrões suspeitos no corpo (já limpo)
    if (req.body && Object.keys(req.body).length > 0) {
      const findings = fullScan(req.body);
      if (findings.length > 0) {
        console.warn('🔍 [Security] Padrões suspeitos encontrados:');
        findings.forEach(f => console.warn(`   - [${f.path}] ${f.message}`));

        return res.status(400).json({
        success: false,
        error: 'Requisição bloqueada por segurança.',
        details: findings,
        });
      }
    }
    next();
  });
}