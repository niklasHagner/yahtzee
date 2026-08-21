FROM node:22-alpine

WORKDIR /app

COPY server/package*.json ./server/
RUN npm --prefix server install --omit=dev

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/server.js"]
