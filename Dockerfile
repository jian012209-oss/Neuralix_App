FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
