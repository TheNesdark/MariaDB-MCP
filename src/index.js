#!/usr/bin/env node

/**
 * Punto de entrada principal para el servidor MCP MariaDB en JavaScript.
 * Soporta transporte stdio (por defecto) y preparación para HTTP/SSE.
 *
 * Uso:
 *   node src/index.js              # transporte stdio
 *   node src/index.js --http 3000  # transporte HTTP en puerto 3000
 */

import { MariaDBServer } from './server.js';
import { logger } from './logger.js';

function parseArgs() {
  const args = process.argv.slice(2);
  let mode = 'stdio';
  let port = 3000;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--http' || arg === '-h') {
      mode = 'http';
      if (args[i + 1] && /^\d+$/.test(args[i + 1])) {
        port = parseInt(args[i + 1], 10);
        i++;
      }
    } else if (arg === '--stdio' || arg === '-s') {
      mode = 'stdio';
    } else if (arg === '--help' || arg === '-?') {
      console.log(`
Uso: node src/index.js [opciones]

Opciones:
  --stdio, -s          Usar transporte stdio (por defecto)
  --http [puerto], -h  Usar transporte HTTP/SSE (puerto por defecto: 3000)
  --help, -?           Mostrar esta ayuda

Variables de entorno requeridas:
  DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
`);
      process.exit(0);
    }
  }

  return { mode, port };
}

async function main() {
  const { mode, port } = parseArgs();
  const server = new MariaDBServer('mariadb-mcp-server');

  try {
    if (mode === 'stdio') {
      await server.runStdio();
    } else if (mode === 'http') {
      await server.runHttp(port);
      // Bloquear proceso para mantener servidor vivo
      await new Promise(() => {});
    }
  } catch (error) {
    logger.error('Error fatal iniciando servidor MCP:', error);
    process.exit(1);
  }
}

main();
