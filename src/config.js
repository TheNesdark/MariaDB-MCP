import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cargar variables de entorno desde el .env raíz del proyecto
const envPath = path.resolve(__dirname, '..', '.env');
dotenv.config({ path: envPath });

/**
 * Valida si una variable booleana de entorno es verdadera.
 * Acepta: 'true', '1', 'yes' (case-insensitive).
 */
function parseBoolean(raw) {
  if (raw == null) return false;
  const lowered = String(raw).trim().toLowerCase();
  return lowered === 'true' || lowered === '1' || lowered === 'yes';
}

/**
 * Obtiene un entero desde una variable de entorno, con valor por defecto.
 */
function parseIntDefault(raw, defaultValue, min = -Infinity, max = Infinity) {
  const num = parseInt(raw, 10);
  if (Number.isNaN(num)) return defaultValue;
  return Math.max(min, Math.min(max, num));
}

// ==================== Configuración de Base de Datos ====================

export const DB_HOST = process.env.DB_HOST || 'localhost';
export const DB_PORT = parseIntDefault(process.env.DB_PORT, 3306, 1, 65535);
export const DB_USER = process.env.DB_USER || 'root';
export const DB_PASSWORD = process.env.DB_PASSWORD || '';
export const DB_NAME = process.env.DB_NAME || '';
export const DB_CHARSET = process.env.DB_CHARSET || 'utf8mb4';

// SSL
export const DB_SSL = parseBoolean(process.env.DB_SSL);
export const DB_SSL_CA = process.env.DB_SSL_CA || '';
export const DB_SSL_CERT = process.env.DB_SSL_CERT || '';
export const DB_SSL_KEY = process.env.DB_SSL_KEY || '';
export const DB_SSL_VERIFY_CERT = parseBoolean(process.env.DB_SSL_VERIFY_CERT);
export const DB_SSL_VERIFY_IDENTITY = parseBoolean(process.env.DB_SSL_VERIFY_IDENTITY);

// Control de servidor
export const MCP_READ_ONLY = parseBoolean(process.env.MCP_READ_ONLY);
export const MCP_MAX_POOL_SIZE = parseIntDefault(process.env.MCP_MAX_POOL_SIZE, 10, 1, 100);
export const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

// Orígenes permitidos para transporte HTTP
export function getAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

export function getAllowedHosts() {
  const raw = process.env.ALLOWED_HOSTS || '';
  if (!raw) return ['localhost', '127.0.0.1'];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

// Validar que credenciales esenciales existan
export function validateConfig() {
  const errors = [];
  if (!DB_USER) errors.push('DB_USER no está definido');
  if (DB_PASSWORD === undefined) errors.push('DB_PASSWORD no está definido');
  if (errors.length > 0) {
    throw new Error(`Configuración inválida: ${errors.join('; ')}`);
  }
}
