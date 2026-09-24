# Build
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Run
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
# Listen on all interfaces inside the container; publish the port privately.
ENV AGENT_HOST=0.0.0.0 AGENT_PORT=4030
EXPOSE 4030
CMD ["node", "dist/index.js"]
