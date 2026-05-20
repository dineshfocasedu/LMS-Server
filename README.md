# Focas-Shopify-Server Deployment Guide

## Steps to Deploy in VPS

### 1. Navigate to the project directory
```bash
cd /prod-focas-server/Focas-Shopify-Server
```

### 2. Pull latest changes from Git
```bash
git pull
```

### 3. Build the Docker image
```bash
docker build -t focas-shopify-server .
```

### 4. Remove old container (if exists)
```bash
docker rm -f focas-shopify-server
```

### 5. Run the new container with port 7000
```bash
docker run -d \
  -p 7000:7000 \
  --env-file .env \
  --name focas-shopify-server \
  focas-shopify-server
```

---

## Quick Deploy (One-liner)
```bash
cd /prod-focas-server/Focas-Shopify-Server && git pull && docker build -t focas-shopify-server . && docker rm -f focas-shopify-server && docker run -d -p 7000:7000 --env-file .env --name focas-shopify-server focas-shopify-server
```

---

## Verify Deployment
```bash
docker ps | grep focas-shopify-server
docker logs focas-shopify-server
```

---

## Important Notes

- **Environment Variables**: Make sure `.env` file exists with required variables including `JWT_SECRET`
- **Port**: Server runs on port 7000
- **Logs**: Check logs with `docker logs focas-shopify-server` if container exits
- **Stop Container**: `docker stop focas-shopify-server`
- **Remove Container**: `docker rm focas-shopify-server`

---

## Troubleshooting

**JWT_SECRET Error:**
Generate a new secret:
```bash
openssl rand -base64 32
```
Update in `.env` and redeploy.

**Port Already in Use:**
```bash
lsof -i :7000
kill -9 <PID>
```

**Container Keeps Exiting:**
```bash
docker logs focas-shopify-server
```
Check the error and fix the issue before redeploying.