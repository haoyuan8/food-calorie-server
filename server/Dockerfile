FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com

COPY index.js prompt.js dishes.json ./

ENV NODE_ENV=production
ENV PORT=80
EXPOSE 80

CMD ["node", "index.js"]
