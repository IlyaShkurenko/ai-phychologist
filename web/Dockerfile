FROM node:22-slim

WORKDIR /app

COPY package*.json ./
COPY web/package*.json ./web/
COPY api/package*.json ./api/
COPY tdlib-service/package*.json ./tdlib-service/

RUN npm install --workspace web --include-workspace-root=false

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--workspace", "web", "--", "--host", "0.0.0.0", "--port", "5173"]
