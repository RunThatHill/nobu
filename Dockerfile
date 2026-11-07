# Base Node image
FROM node:20-alpine

# Install build dependencies, python and ffmpeg for maximum audio/video compatibility
RUN apk add --no-cache ffmpeg python3 make g++ git

# Set working directory
WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install dependencies (production)
RUN npm ci --omit=dev || npm install --omit=dev

# Copy application files
COPY . .

# Expose port for health checks / keep-alive
EXPOSE 3000

# Start Nobu
CMD ["node", "src/index.js"]
