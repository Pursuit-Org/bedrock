# Frontend Dockerfile for React application
# Multi-stage build: Build React app, then serve with nginx

# Stage 1: Build the React app
FROM node:22.23.4-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --legacy-peer-deps

# Copy source code
COPY . .

# Debug: Show if .env.production exists
RUN echo "=== Checking for .env.production ===" && \
    if [ -f .env.production ]; then \
        echo "✅ .env.production EXISTS:" && cat .env.production; \
    else \
        echo "❌ .env.production NOT FOUND"; \
    fi

# Set NODE_ENV to production
ENV NODE_ENV=production

# Explicitly set REACT_APP_API_URL from .env.production
# React requires env vars to be set at build time, not read from files
RUN if [ -f .env.production ]; then \
        REACT_APP_API_URL=$(grep REACT_APP_API_URL .env.production | cut -d '=' -f2) && \
        echo "export REACT_APP_API_URL=$REACT_APP_API_URL" > /tmp/env.sh; \
    fi

# Source the env and build
RUN . /tmp/env.sh && \
    echo "=== Building with REACT_APP_API_URL=$REACT_APP_API_URL ===" && \
    npm run build

# Debug: Check what's in the built files
RUN echo "=== Checking built files for localhost ===" && \
    grep -r "localhost:8000\|localhost:3000" build/static/js/*.js | head -5 || echo "No localhost found in JS files"

# Stage 2: Serve with nginx
FROM nginx:alpine

# Copy built files from builder stage
COPY --from=builder /app/build /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose port 8080 (Cloud Run requirement)
EXPOSE 8080

# Start nginx
CMD ["nginx", "-g", "daemon off;"]

