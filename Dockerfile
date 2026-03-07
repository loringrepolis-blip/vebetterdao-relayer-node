FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN NODE_OPTIONS=--max-old-space-size=4096 npx tsc

FROM node:20-alpine
RUN apk add --no-cache tini
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY --from=builder /app/dist ./dist
ENV RELAYER_NETWORK=mainnet
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
