FROM node:22-slim

WORKDIR /app

COPY package*.json ./
COPY api/package*.json ./api/
COPY web/package*.json ./web/
COPY tdlib-service/package*.json ./tdlib-service/

RUN npm install --workspace api --include-workspace-root=false

COPY . .

EXPOSE 4001

CMD ["npm", "run", "dev", "--workspace", "api"]
