# Signage Backend (API)

## Run locally
1. `npm install`
2. Create `.env` from `.env.example`
3. `npm run db:push` (optional, if you want Drizzle to push schema)
4. `npm run dev`

## Deploy on Render
- Build command: `npm install && npm run build`
- Start command: `npm start`
- Set env vars:
  - `DATABASE_URL`
  - `JWT_SECRET`
  - `CORS_ORIGIN` (your Vercel domain)
