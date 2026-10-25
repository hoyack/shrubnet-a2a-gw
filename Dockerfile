FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json openapi.yaml ./
RUN useradd -r -u 10001 gateway && mkdir -p telemetry && chown gateway telemetry
USER gateway
# The gateway runs `openclaw agent --local` as a subprocess. The image does NOT include openclaw:
# install it in a derived image or mount it onto PATH, otherwise /readyz returns 503 and tasks fail.
# KIMICLAW_TOKEN and GATEWAY_* come from the runtime env (never baked in).
EXPOSE 8000
# Liveness only: /healthz is public. /readyz is not used because it is 503 until openclaw is present.
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
