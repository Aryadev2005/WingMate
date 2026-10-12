# Deploy the landing page on any Vercel account

1. Vercel dashboard > Add New > Project > import `Aryadev2005/WingMate`.
2. Set **Root Directory** to `landing`. Everything else is picked up from `vercel.json`.
3. Before the first deploy, add Environment Variables:
   - `CODE_SECRET`  any long random string (signs referral codes)
   - `ADMIN_KEY`    any long random string (unlocks `/api/admin?key=...` CSV export)
   - `META_PIXEL_ID` optional, your Meta Pixel ID
4. Storage tab > Create > **Blob** > make it **Private** > connect to this project (adds `BLOB_READ_WRITE_TOKEN`).
5. Deploy. If you added the Blob store after the first deploy, redeploy once.
6. Project Settings > Deployment Protection: set Vercel Authentication to **Preview only** so the public can open production.

Generate secrets:  `openssl rand -hex 32`
