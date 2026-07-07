import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LOG_LEVEL } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logsDir = path.resolve(__dirname, '..', 'logs');

/**
 * Logger configurado para el servidor MCP.
 * Escribe a stderr (para no contaminar stdout en modo stdio)
 * y archivos rotados diariamente.
 *
 * En modo MCP stdio, stdout está reservado para mensajes JSON del protocolo,
 * por lo que TODO el logging debe ir a stderr.
 */

const transports = [
  // Consola: SIEMPRE stderr para no romper stdio transport
  new winston.transports.Console({
    stderrLevels: ['debug', 'info', 'warn', 'error'],
    consoleWarnLevels: ['debug', 'info', 'warn', 'error']
  })
];

// Intentar crear transporte de archivo; si falla (permisos), solo usar consola
try {
  fs.mkdirSync(logsDir, { recursive: true });
  fs.accessSync(logsDir, fs.constants.W_OK);
  transports.push(
    new DailyRotateFile({
      dirname: logsDir,
      filename: 'mcp-server-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '7d',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
      )
    })
  );
} catch {
  // Sin permisos de escritura: log solo a consola
}

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      let line = `${timestamp} [${level.toUpperCase()}]: ${message}`;
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      return line + metaStr;
    })
  ),
  transports,
  exitOnError: false
});
