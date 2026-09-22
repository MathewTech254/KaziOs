FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
COPY .npmrc ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages ./packages
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
