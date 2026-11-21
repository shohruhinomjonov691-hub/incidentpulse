# Sandbox only: a node container whose app is supervised by pm2 (scenario 11).
FROM node:24-alpine
RUN npm install --global --no-audit --no-fund pm2@7.1.2
ENV PM2_HOME=/tmp/.pm2
WORKDIR /app
COPY ecosystem.config.cjs /etc/ecosystem.config.cjs
CMD ["pm2-runtime", "start", "/etc/ecosystem.config.cjs"]
