FROM node:22-slim

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 5004

CMD ["node", "processor.js"]
