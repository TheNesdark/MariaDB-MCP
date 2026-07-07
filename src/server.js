import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import http from 'http';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_CHARSET,
  DB_SSL, DB_SSL_CA, DB_SSL_CERT, DB_SSL_KEY, DB_SSL_VERIFY_CERT, DB_SSL_VERIFY_IDENTITY,
  MCP_READ_ONLY, MCP_MAX_POOL_SIZE, getAllowedOrigins, getAllowedHosts,
  validateConfig
} from './config.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== Helpers ====================

/**
 * Valida si un string es un identificador SQL válido (alfanumérico + guiones bajos, no empieza con número).
 */
function isValidIdentifier(name) {
  if (!name || typeof name !== 'string') return false;
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

/**
 * Elimina comentarios SQL de una cadena (lineales y multi-línea).
 */
function stripSqlComments(sql) {
  // Elimina comentarios de una línea (--)
  let cleaned = sql.replace(/--.*?$/gm, '');
  // Elimina comentarios multilínea (/* */)
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');
  return cleaned.trim();
}

/**
 * Elimina literales de cadena de una consulta SQL para evitar
 * falsos positivos al buscar palabras clave dentro de comillas.
 */
function stripStringLiterals(sql) {
  // Reemplaza cadenas simples: '...'
  let cleaned = sql.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  // Reemplaza cadenas dobles: "..."
  cleaned = cleaned.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return cleaned;
}

// ==================== MariaDB MCP Server ====================

export class MariaDBServer {
  constructor(serverName = 'mariadb-mcp-server') {
    this.serverName = serverName;
    this.pool = null;
    this.isReadOnly = MCP_READ_ONLY;
    this.autocommit = !MCP_READ_ONLY;

    // Inicializar servidor MCP
    this.server = new Server(
      { name: serverName, version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    this._setupErrorHandling();

    logger.info(`Inicializando ${serverName}...`);
    if (this.isReadOnly) {
      logger.warn('Servidor ejecutándose en modo SOLO LECTURA. Las operaciones de escritura están deshabilitadas.');
    }
  }

  _setupErrorHandling() {
    this.server.onerror = (error) => {
      logger.error('Error en el servidor MCP:', error);
    };

    process.on('SIGINT', async () => {
      await this.close();
      process.exit(0);
    });
  }

  // ---------- Ciclo de vida del pool ----------

  async initializePool() {
    if (this.pool) {
      logger.info('Pool de conexiones ya inicializado.');
      return;
    }

    validateConfig();

    try {
      const ssl = this._buildSslConfig();

      const poolConfig = {
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME || undefined,
        waitForConnections: true,
        connectionLimit: MCP_MAX_POOL_SIZE,
        queueLimit: 0,
        charset: DB_CHARSET,
        ssl: ssl || undefined,
        // Deshabilitar MULTI_STATEMENTS por seguridad
        multipleStatements: false
      };

      if (ssl) {
        logger.info(`Creando pool seguro para ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME} (max: ${MCP_MAX_POOL_SIZE}, charset: ${DB_CHARSET})`);
      } else {
        logger.info(`Creando pool para ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME} (max: ${MCP_MAX_POOL_SIZE}, charset: ${DB_CHARSET})`);
      }

      this.pool = mysql.createPool(poolConfig);
      logger.info('Pool de conexiones inicializado correctamente.');

      if (this.isReadOnly) {
        await this._warnIfFilePrivilegeEnabled();
      }
    } catch (error) {
      logger.error('Error inicializando pool de conexiones:', error);
      this.pool = null;
      throw new Error(`No se pudo inicializar el pool: ${error.message}`);
    }
  }

  _buildSslConfig() {
    if (!DB_SSL) return null;

    const sslConfig = {};

    if (DB_SSL_CA) {
      const caPath = path.resolve(DB_SSL_CA);
      if (fs.existsSync(caPath)) {
        sslConfig.ca = fs.readFileSync(caPath);
        logger.info(`Certificado CA cargado: ${caPath}`);
      } else {
        logger.warn(`Archivo CA no encontrado: ${caPath}`);
      }
    }

    if (DB_SSL_CERT && DB_SSL_KEY) {
      const certPath = path.resolve(DB_SSL_CERT);
      const keyPath = path.resolve(DB_SSL_KEY);
      if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        sslConfig.cert = fs.readFileSync(certPath);
        sslConfig.key = fs.readFileSync(keyPath);
        logger.info(`Certificado cliente cargado: ${certPath}`);
      } else {
        logger.warn(`Certificado cliente no encontrado: cert=${certPath}, key=${keyPath}`);
      }
    }

    if (!DB_SSL_VERIFY_CERT) {
      sslConfig.rejectUnauthorized = false;
      logger.info('Verificación de certificado SSL deshabilitada');
    } else {
      sslConfig.rejectUnauthorized = true;
      if (DB_SSL_VERIFY_IDENTITY) {
        logger.info('Verificación SSL completa habilitada (cert + identidad)');
      } else {
        logger.info('Verificación de certificado SSL habilitada (sin identidad)');
      }
    }

    logger.info('SSL habilitado para la conexión de base de datos');
    return sslConfig;
  }

  async closePool() {
    if (this.pool) {
      logger.info('Cerrando pool de conexiones...');
      try {
        await this.pool.end();
        logger.info('Pool de conexiones cerrado.');
      } catch (error) {
        logger.error('Error cerrando el pool:', error);
      } finally {
        this.pool = null;
      }
    }
  }

  async close() {
    await this.closePool();
    await this.server.close();
    logger.info('Servidor MCP cerrado.');
  }

  // ---------- Seguridad ----------

  async _warnIfFilePrivilegeEnabled() {
    if (!this.pool) return;

    try {
      const [rows] = await this.pool.execute('SELECT CURRENT_USER() AS user');
      const currentUser = rows[0]?.user;
      if (!currentUser) return;

      const userId = currentUser.split('@')[0];
      const hostPart = currentUser.split('@')[1] || '%';

      const [grants] = await this.pool.execute(`SHOW GRANTS FOR \`${userId}\`@\`${hostPart}\``);
      const grantTexts = grants.map(row => Object.values(row)[0]);

      const hasFilePriv = grantTexts.some(
        grant => /\bFILE\b/i.test(grant) && grant.toUpperCase().includes('ON *.*')
      );

      if (hasFilePriv) {
        logger.error(
          'El usuario de base de datos conectado tiene el privilegio global FILE. ' +
          'Esto significa que el servidor NO opera en un modo totalmente de solo lectura, ' +
          'ya que MariaDB/MySQL permiten lectura/escritura del sistema de archivos vía SQL ' +
          '(p. ej. SELECT ... INTO OUTFILE, LOAD_FILE()). ' +
          'Esto no se puede solucionar desde el cliente; revoque FILE para el usuario de la base de datos.'
        );
      }
    } catch (error) {
      logger.debug(`No se pudo determinar si FILE está habilitado: ${error.message}`);
    }
  }

  // ---------- Ejecución de queries ----------

  _isConnectionError(error) {
    if (!error) return false;
    const code = (error.code || '').toUpperCase();
    // Códigos de error de conexión de mysql2
    const connCodes = [
      'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
      'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
      'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
      'ER_CON_COUNT_ERROR', 'ER_CONNECTION_KILLED',
      'ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK',
    ];
    if (connCodes.includes(code)) return true;
    const msg = (error.message || '').toLowerCase();
    return (
      msg.includes('lost connection') ||
      msg.includes('cannot connect') ||
      msg.includes('already closed') ||
      msg.includes('pool is draining') ||
      msg.includes('handshake inactivity') ||
      msg.includes('connection destroyed') ||
      msg.includes('socket disconnected')
    );
  }

  async _executeQuery(sql, params = null, database = null) {
    if (!this.pool) {
      throw new Error('Pool de conexiones no disponible. Llame a initializePool() primero.');
    }

    // Validación de solo lectura
    const allowedPrefixes = ['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'USE'];
    const cleanSql = stripSqlComments(sql);
    const queryUpper = cleanSql.toUpperCase();
    const isAllowed = allowedPrefixes.some(prefix => queryUpper.startsWith(prefix));

    if (this.isReadOnly && !isAllowed) {
      logger.warn(`Bloqueada query potencialmente no de solo lectura: ${sql.substring(0, 100)}...`);
      throw new PermissionError('Operación prohibida: el servidor está en modo solo lectura.');
    }

    if (this.isReadOnly) {
      const noStrings = stripStringLiterals(cleanSql).toUpperCase();

      if (/\bLOAD_FILE\s*\(/.test(noStrings)) {
        logger.warn(`Bloqueada query con LOAD_FILE(): ${sql.substring(0, 100)}...`);
        throw new PermissionError('Operación prohibida: LOAD_FILE() no está permitido por seguridad.');
      }

      if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/.test(noStrings)) {
        logger.warn(`Bloqueada query con SELECT INTO OUTFILE/DUMPFILE: ${sql.substring(0, 100)}...`);
        throw new PermissionError('Operación prohibida: SELECT INTO OUTFILE/DUMPFILE no están permitidos por seguridad.');
      }
    }

    logger.info(`Ejecutando query (DB: ${database || DB_NAME || '(default)'}): ${sql.substring(0, 120)}...`);
    if (params) logger.debug('Parámetros:', params);

    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      let connection;
      try {
        connection = await this.pool.getConnection();

        if (database && database !== DB_NAME) {
          await connection.execute(`USE \`${database}\``);
        }

        const [rows] = params
          ? await connection.execute(sql, params)
          : await connection.execute(sql);

        logger.info(`Query ejecutada correctamente. Filas: ${Array.isArray(rows) ? rows.length : 0}`);
        return Array.isArray(rows) ? rows : [];
      } catch (error) {
        lastError = error;

        if (this._isConnectionError(error)) {
          logger.warn(`Error de conexión (intento ${attempt + 1}/2): ${error.message}`);
          if (connection) {
            try { connection.destroy(); } catch (_) { /* ignora */ }
            connection = null;
          }
          // Esperar 500ms antes de reintentar con una conexión nueva
          if (attempt === 0) await new Promise(r => setTimeout(r, 500));
        } else {
          // Error de SQL (sintaxis, tabla no existe, etc.) — no reintentar
          logger.error(`Error ejecutando query: ${error.message}`, { sql: sql.substring(0, 200) });
          throw new Error(`Error de base de datos: ${error.message}`);
        }
      } finally {
        if (connection) {
          try { connection.release(); } catch (_) { connection.destroy(); }
        }
      }
    }

    // Si llegamos aquí es porque ambos reintentos fallaron por error de conexión
    throw new Error(`Error de base de datos tras reintentos: ${lastError.message}`);
  }

  async _databaseExists(databaseName) {
    if (!isValidIdentifier(databaseName)) return false;
    try {
      const sql = 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?';
      const rows = await this._executeQuery(sql, [databaseName], 'information_schema');
      return rows.length > 0;
    } catch (error) {
      logger.error(`Error verificando existencia de BD '${databaseName}':`, error);
      return false;
    }
  }

  async _tableExists(databaseName, tableName) {
    if (!isValidIdentifier(databaseName) || !isValidIdentifier(tableName)) return false;
    try {
      const sql = 'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?';
      const rows = await this._executeQuery(sql, [databaseName, tableName], 'information_schema');
      return rows.length > 0;
    } catch (error) {
      logger.error(`Error verificando existencia de tabla '${databaseName}.${tableName}':`, error);
      return false;
    }
  }

  // ---------- Definición de herramientas MCP ----------

  registerTools() {
    // Listado de herramientas
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_databases',
          description: 'Lista todas las bases de datos accesibles en el servidor MariaDB.',
          inputSchema: { type: 'object', properties: {} }
        },
        {
          name: 'list_tables',
          description: 'Lista todas las tablas de una base de datos específica.',
          inputSchema: {
            type: 'object',
            properties: {
              database_name: { type: 'string', description: 'Nombre de la base de datos' }
            },
            required: ['database_name']
          }
        },
        {
          name: 'get_table_schema',
          description: 'Obtiene la estructura de columnas de una tabla (nombre, tipo, nullable, clave, default, extra).',
          inputSchema: {
            type: 'object',
            properties: {
              database_name: { type: 'string', description: 'Nombre de la base de datos' },
              table_name: { type: 'string', description: 'Nombre de la tabla' }
            },
            required: ['database_name', 'table_name']
          }
        },
        {
          name: 'get_table_schema_with_relations',
          description: 'Obtiene la estructura de columnas incluyendo relaciones de clave foránea.',
          inputSchema: {
            type: 'object',
            properties: {
              database_name: { type: 'string', description: 'Nombre de la base de datos' },
              table_name: { type: 'string', description: 'Nombre de la tabla' }
            },
            required: ['database_name', 'table_name']
          }
        },
        {
          name: 'execute_sql',
          description:
            'Ejecuta una consulta SQL (SELECT, SHOW, DESCRIBE) y retorna los resultados. ' +
            'En modo solo lectura (por defecto), se bloquean queries de escritura.',
          inputSchema: {
            type: 'object',
            properties: {
              sql_query: { type: 'string', description: 'Consulta SQL a ejecutar' },
              database_name: { type: 'string', description: 'Base de datos sobre la cual ejecutar' },
              parameters: {
                type: 'array',
                items: { type: 'string' },
                description: 'Parámetros para consultas parametrizadas (reemplazan ?)'
              }
            },
            required: ['sql_query', 'database_name']
          }
        },
        {
          name: 'create_database',
          description: 'Crea una nueva base de datos si no existe. Requiere modo escritura (READ_ONLY=false).',
          inputSchema: {
            type: 'object',
            properties: {
              database_name: { type: 'string', description: 'Nombre de la base de datos a crear' }
            },
            required: ['database_name']
          }
        }
      ]
    }));

    // Ejecutor de herramientas
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      logger.info(`TOOL START: ${name} llamado con argumentos:`, args);

      try {
        let result;
        switch (name) {
          case 'list_databases':
            result = await this.toolListDatabases();
            break;
          case 'list_tables':
            result = await this.toolListTables(args.database_name);
            break;
          case 'get_table_schema':
            result = await this.toolGetTableSchema(args.database_name, args.table_name);
            break;
          case 'get_table_schema_with_relations':
            result = await this.toolGetTableSchemaWithRelations(args.database_name, args.table_name);
            break;
          case 'execute_sql':
            result = await this.toolExecuteSql(args.sql_query, args.database_name, args.parameters || null);
            break;
          case 'create_database':
            result = await this.toolCreateDatabase(args.database_name);
            break;
          default:
            throw new Error(`Herramienta desconocida: ${name}`);
        }

        logger.info(`TOOL END: ${name} completado.`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        logger.error(`TOOL ERROR: ${name} falló:`, error);
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    });
  }

  // ---------- Implementación de herramientas ----------

  async toolListDatabases() {
    const sql = 'SELECT SCHEMA_NAME AS Database FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN (\'information_schema\', \'performance_schema\', \'mysql\', \'sys\') ORDER BY SCHEMA_NAME';
    const rows = await this._executeQuery(sql, null, 'information_schema');
    return rows.map(row => row.Database);
  }

  async toolListTables(databaseName) {
    if (!isValidIdentifier(databaseName)) {
      throw new Error(`Nombre de base de datos inválido: ${databaseName}`);
    }
    const sql = 'SHOW TABLES';
    const rows = await this._executeQuery(sql, null, databaseName);
    return rows.map(row => Object.values(row)[0]);
  }

  async toolGetTableSchema(databaseName, tableName) {
    if (!isValidIdentifier(databaseName)) {
      throw new Error(`Nombre de base de datos inválido: ${databaseName}`);
    }
    if (!isValidIdentifier(tableName)) {
      throw new Error(`Nombre de tabla inválido: ${tableName}`);
    }

    const sql = `DESCRIBE \`${databaseName}\`.\`${tableName}\``;
    const rows = await this._executeQuery(sql, null, databaseName);

    if (!rows || rows.length === 0) {
      // Verificar si la tabla existe realmente
      const exists = await this._tableExists(databaseName, tableName);
      if (!exists) {
        throw new Error(`Tabla '${databaseName}.${tableName}' no encontrada o inaccesible.`);
      }
      // Si existe pero no se puede describir, probablemente es un VIEW sin permisos
      throw new Error(`No se pudo obtener esquema de '${databaseName}.${tableName}'. Puede ser un VIEW o carecer de permisos.`);
    }

    const schema = {};
    for (const row of rows) {
      const colName = row.Field;
      if (colName) {
        schema[colName] = {
          type: row.Type,
          nullable: (row.Null || '').toUpperCase() === 'YES',
          key: row.Key,
          default: row.Default,
          extra: row.Extra
        };
      }
    }

    return schema;
  }

  async toolGetTableSchemaWithRelations(databaseName, tableName) {
    // Obtener esquema básico
    const basicSchema = await this.toolGetTableSchema(databaseName, tableName);

    // Preparar esquema enriquecido
    const enhanced = {};
    for (const [colName, info] of Object.entries(basicSchema)) {
      enhanced[colName] = { ...info, foreign_key: null };
    }

    // Obtener claves foráneas
    const fkSql = `
      SELECT
        kcu.COLUMN_NAME AS column_name,
        kcu.CONSTRAINT_NAME AS constraint_name,
        kcu.REFERENCED_TABLE_NAME AS referenced_table,
        kcu.REFERENCED_COLUMN_NAME AS referenced_column,
        rc.UPDATE_RULE AS on_update,
        rc.DELETE_RULE AS on_delete
      FROM information_schema.KEY_COLUMN_USAGE kcu
      INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
        AND kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
      WHERE kcu.TABLE_SCHEMA = ?
        AND kcu.TABLE_NAME = ?
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
    `;

    const fkRows = await this._executeQuery(fkSql, [databaseName, tableName], 'information_schema');

    for (const fk of fkRows) {
      const colName = fk.column_name;
      if (enhanced[colName]) {
        enhanced[colName].foreign_key = {
          constraint_name: fk.constraint_name,
          referenced_table: fk.referenced_table,
          referenced_column: fk.referenced_column,
          on_update: fk.on_update,
          on_delete: fk.on_delete
        };
      }
    }

    return {
      table_name: tableName,
      columns: enhanced
    };
  }

  async toolExecuteSql(sqlQuery, databaseName, parameters) {
    if (databaseName && !isValidIdentifier(databaseName)) {
      throw new Error(`Nombre de base de datos inválido: ${databaseName}`);
    }
    return this._executeQuery(sqlQuery, parameters, databaseName);
  }

  async toolCreateDatabase(databaseName) {
    if (this.isReadOnly) {
      throw new PermissionError('Operación prohibida: el servidor está en modo solo lectura (READ_ONLY=true).');
    }
    if (!isValidIdentifier(databaseName)) {
      throw new Error(`Nombre inválido para crear base de datos: ${databaseName}`);
    }

    const exists = await this._databaseExists(databaseName);
    if (exists) {
      return {
        status: 'exists',
        message: `La base de datos '${databaseName}' ya existe.`,
        database_name: databaseName
      };
    }

    const sql = `CREATE DATABASE IF NOT EXISTS \`${databaseName}\``;
    await this._executeQuery(sql);

    return {
      status: 'success',
      message: `Base de datos '${databaseName}' creada exitosamente.`,
      database_name: databaseName
    };
  }

  // ---------- Inicio de transporte ----------

  /**
   * Inicia el servidor MCP por stdio (transporte por defecto).
   */
  async runStdio() {
    await this.initializePool();
    this.registerTools();

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info(`Servidor MCP (${this.serverName}) iniciado por stdio.`);
  }

  /**
   * Inicia el servidor MCP por HTTP con endpoint /health para orquestadores.
   * Expone:
   *   GET /health  → estado del servidor y pool de conexiones
   *   POST /mcp    → reservado para futuro transporte MCP over HTTP
   */
  async runHttp(port = 3000) {
    await this.initializePool();
    this.registerTools();

    const allowedOrigins = getAllowedOrigins();
    const allowedHosts = getAllowedHosts();

    const httpServer = http.createServer(async (req, res) => {
      // CORS headers
      const origin = req.headers.origin || '';
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Healthcheck endpoint
      if (req.url === '/health' && req.method === 'GET') {
        try {
          const conn = await this.pool.getConnection();
          conn.release();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'healthy',
            server: this.serverName,
            version: '1.0.0',
            database: DB_NAME,
            readOnly: this.isReadOnly,
            pool: { active: this.pool._allConnections?.length || 0, limit: MCP_MAX_POOL_SIZE }
          }));
        } catch (error) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: 'unhealthy',
            error: error.message
          }));
        }
        return;
      }

      // Ruta no encontrada
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    httpServer.listen(port, () => {
      logger.info(`Servidor HTTP (${this.serverName}) escuchando en puerto ${port}`);
      logger.info(`Healthcheck: http://localhost:${port}/health`);
    });

    // Manejo graceful de cierre
    const shutdown = async () => {
      logger.info('Cerrando servidor HTTP...');
      httpServer.close();
      if (this.pool) await this.pool.end();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }
}

// ==================== Excepciones personalizadas ====================

class PermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermissionError';
  }
}
