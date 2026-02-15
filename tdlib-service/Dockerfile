FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    cmake \
    g++ \
    git \
    gperf \
    libssl-dev \
    make \
    python3 \
    zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch v1.8.0 https://github.com/tdlib/td.git /tmp/td \
  && cmake -S /tmp/td -B /tmp/td/build -DCMAKE_BUILD_TYPE=Release \
  && cmake --build /tmp/td/build --target tdjson -j"$(nproc)" \
  && cp /tmp/td/build/libtdjson.so /usr/local/lib/libtdjson.so \
  && ldconfig \
  && rm -rf /tmp/td

COPY package*.json ./
COPY tdlib-service/package*.json ./tdlib-service/
COPY api/package*.json ./api/
COPY web/package*.json ./web/

RUN npm install --workspace tdlib-service --include-workspace-root=false

COPY . .

ENV TDLIB_LIBRARY_PATH=/usr/local/lib/libtdjson.so

EXPOSE 4002

CMD ["npm", "run", "dev", "--workspace", "tdlib-service"]
