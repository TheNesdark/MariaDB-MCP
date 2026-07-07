# MariaDB MCP Server (JavaScript)

Servidor MCP escrito en **Node.js / JavaScript** para interactuar con bases de datos **MariaDB/MySQL**.

## Características

- **Transporte stdio** compatible con el protocolo MCP (Model Context Protocol).
- **Transporte HTTP/SSE** preparado para extenderse con un bridge web.
- **Conexión pool** usando `mysql2/promise` con tamaño configurable.
- **Soporte SSL** con CA, certificados cliente y configuración de verificación.
- **Modo solo lectura (READ_ONLY)** que bloquea queries de escritura y funciones de archivo (`LOAD_FILE`, `INTO OUTFILE`).
- **Logging** a `stderr` (compatible con stdio transport) y archivos rotados diariamente con `winston`.
- **Docker y Docker Compose** listos para usar.

## Herramientas MCP expuestas

| Herramienta | Descripción |
|-------------|-------------|
| `list_databases` | Lista todas las bases de datos accesibles. |
| `list_tables` | Lista las tablas de una base de datos. |
| `get_table_schema` | Obtiene columnas, tipos, nullable, keys, defaults y extras. |
| `get_table_schema_with_relations` | Igual que `get_table_schema` pero incluye claves foráneas. |
| `execute_sql` | Ejecuta queries `SELECT/SHOW/DESCRIBE`. Valida parámetros y modo solo lectura. |
| `create_database` | Crea una base de datos (requiere `MCP_READ_ONLY=false`). |

## Requisitos

- **Node.js** >= 18 (recomendado 20 LTS)
- **MariaDB/MySQL** accesible desde la red del servidor

## Instalación

```bash
# Clonar o copiar la carpeta MariaDB-MCP
cd MariaDB-MCP

# Instalar dependencias
npm install
```

## Configuración

Copia el archivo de ejemplo y ajusta tus credenciales:

```bash
cp .env.example .env
```

Variables disponibles:

| Variable | Descripción | Default |
|----------|-------------|---------|
| `DB_HOST` | Host del servidor MariaDB | `localhost` |
| `DB_PORT` | Puerto | `3306` |
| `DB_USER` | Usuario | `root` |
| `DB_PASSWORD` | Contraseña | *(vacío)* |
| `DB_NAME` | Base de datos por defecto | `genoma` |
| `DB_CHARSET` | Charset de conexión | `utf8mb4` |
| `DB_SSL` | Habilitar SSL | `false` |
| `DB_SSL_CA` | Ruta al certificado CA | *(vacío)* |
| `DB_SSL_CERT` | Ruta al certificado cliente | *(vacío)* |
| `DB_SSL_KEY` | Ruta a la clave privada cliente | *(vacío)* |
| `DB_SSL_VERIFY_CERT` | Verificar certificado | `true` |
| `DB_SSL_VERIFY_IDENTITY` | Verificar identidad del host | `true` |
| `MCP_READ_ONLY` | Modo solo lectura | `true` |
| `MCP_MAX_POOL_SIZE` | Tamaño máximo del pool | `10` |
| `LOG_LEVEL` | Nivel de log (`debug`,`info`,`warn`,`error`) | `info` |
| `ALLOWED_ORIGINS` | Orígenes CORS separados por coma | *(vacío)* |
| `ALLOWED_HOSTS` | Hosts permitidos separados por coma | `localhost,127.0.0.1` |

## Uso

### Modo stdio (por defecto)

```bash
npm start
# o
node src/index.js
```

### Modo HTTP/SSE

```bash
node src/index.js --http 3000
```

### Ayuda

```bash
node src/index.js --help
```

## Docker

### Construir y ejecutar

```bash
# Modo stdio ( foreground )
docker-compose run --rm mcp-server

# Modo HTTP ( background )
docker-compose up -d mcp-server
```

> Asegúrese de que las variables de entorno estén definidas en un archivo `.env` o en el shell antes de ejecutar `docker-compose`.

## Seguridad

- **MULTI_STATEMENTS** y **LOCAL_INFILE** están desactivados en el pool de conexiones.
- En modo `READ_ONLY`, solo se permiten queries que inicien con `SELECT`, `SHOW`, `DESC`, `DESCRIBE` o `USE`.
- Se bloquean explícitamente las funciones `LOAD_FILE()` y sentencias `INTO OUTFILE/DUMPFILE`.
- Se detecta y se alerta si el usuario de base de datos posee el privilegio global `FILE`.

## Estructura del proyecto

```
MariaDB-MCP/
├── src/
│   ├── index.js      # Punto de entrada y CLI
│   ├── server.js     # Lógica MCP, pool y herramientas
│   ├── config.js     # Variables de entorno
│   └── logger.js     # Configuración de winston
├── logs/             # Archivos de log rotados
├── .env.example
├── .gitignore
├── .dockerignore
├── Dockerfile
├── docker-compose.yml
├── package.json
└── README.md
```

## Licencia

MIT
