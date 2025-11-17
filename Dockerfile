FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies
RUN npm ci --only=production

# Generate Prisma Client
RUN npx prisma generate

# Copy app source
COPY . .

# Expose port
EXPOSE 8080

# Start app
CMD ["node", "server.js"]
