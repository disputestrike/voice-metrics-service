FROM node:18-alpine

WORKDIR /app

# Cache bust — force clean build
ARG CACHEBUST=1

# Copy package files and install deps
COPY package.json ./
RUN npm install --production

# Copy application
COPY index.js ./

EXPOSE 3001

CMD ["node", "index.js"]
