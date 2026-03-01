# ── Build stage ──────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/skills ./skills
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
EXPOSE 18800
CMD ["node", "dist-server/index.js"]
