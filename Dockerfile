# MariaDB MCP Server (JavaScript/Node.js)
# Multi-stage no necesario: imagen ligera con alpine
FROM node:22-alpine

WORKDIR /app

# dumb-init para manejo correcto de señales (SIGTERM, SIGINT)
RUN apk add --no-cache dumb-init

# Copiar e instalar dependencias primero (cache layer)
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copiar código fuente
COPY src/ ./src/

# Crear directorio de logs
RUN mkdir -p /app/logs

# Healthcheck para orquestadores (Docker Compose, Swarm, K8s)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]

# Por defecto: stdio (MCP). Para HTTP pasar --http 3000
CMD ["node", "src/index.js"]
