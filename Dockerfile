FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=9000
ENV APP_ENV=production
COPY package.json ./
COPY src ./src
EXPOSE 9000
CMD ["node", "src/server/index.mjs"]
