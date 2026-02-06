FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY docs ./docs

# assets/ и data/ могут быть пустыми и не попадать в git-контекст,
# поэтому создаём их явно, чтобы бот мог работать с локальными файлами при необходимости.
RUN mkdir -p assets data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
