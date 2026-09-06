FROM node:18-bullseye-slim

# ffmpeg + шрифты (DejaVu поддерживает латиницу и кириллицу)
RUN apt-get update \
    && apt-get install -y --no-install-recommends --fix-missing \
       ffmpeg fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
