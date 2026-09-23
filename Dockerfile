# Cituna remote MCP server — the Streamable HTTP transport (dist/http.js).
#
# Two stages on purpose, unlike api/Dockerfile: the API runs its TypeScript
# through tsx and therefore needs devDependencies at runtime, but this service
# runs compiled JS, so the toolchain can be left behind in the builder. The
# runtime image ends up with one production dependency (@modelcontextprotocol/sdk).
#
# Build context is mcp/. Nothing outside this directory is referenced — the tool
# layer lives in src/tools.ts, which both this server and the npm package import.

FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# --omit=dev: tsx/typescript/@types are build-time only for this entrypoint.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The MCP endpoint is /mcp; / and /healthz are informational.
ENV PORT=8080
EXPOSE 8080

# Liveness only — deliberately does not call the Cituna backend, so a backend
# blip cannot cause the platform to restart-loop a healthy MCP process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run as the image's non-root user.
USER node

CMD ["node", "dist/http.js"]
