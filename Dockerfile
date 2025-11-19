FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies + PM2
RUN npm ci --only=production && npm install -g pm2

# Generate Prisma Client
RUN npx prisma generate

# Copy app source
COPY . .

# Expose port
EXPOSE 8080

# Start with PM2
CMD ["pm2-runtime", "start", "ecosystem.config.js"]