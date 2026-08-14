# Vercel Deployment Fix for React SPA

## Problem
When deploying a React Single Page Application (SPA) to Vercel, you may encounter a 404 error when:
- Refreshing the page on any route (e.g., `/dashboard`)
- Navigating directly to a URL
- Using browser back/forward buttons

## Solution

### 1. Vercel Configuration (`vercel.json`)
```json
{
  "rewrites": [
    {
      "source": "/((?!api/.*).*)",
      "destination": "/index.html"
    }
  ],
  "headers": [
    {
      "source": "/static/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    }
  ]
}
```

### 2. Backup Redirects (`public/_redirects`)
```
/*    /index.html   200
```

### 3. Build Configuration
Ensure your `vite.config.ts` has proper build settings:
```typescript
export default defineConfig({
  build: {
    outDir: "dist",
    assetsDir: "assets",
  },
});
```

## Deployment Steps

1. **Commit the configuration files:**
   ```bash
   git add vercel.json public/_redirects
   git commit -m "Add Vercel SPA configuration"
   git push
   ```

2. **Redeploy on Vercel:**
   - Go to your Vercel dashboard
   - Click "Redeploy" on your latest deployment
   - Or trigger a new deployment by pushing to your main branch

3. **Verify the fix:**
   - Visit your domain
   - Navigate to any route (e.g., `/dashboard`)
   - Refresh the page - it should work without 404 errors

## How It Works

- **Rewrites**: Tells Vercel to serve `index.html` for all routes that don't start with `/api/`
- **Headers**: Optimizes caching for static assets
- **SPA Routing**: React Router handles client-side routing after the initial page load

## Alternative Solutions

If the above doesn't work, try:

1. **Check Vercel Build Settings:**
   - Framework Preset: "Vite"
   - Build Command: `npm run build`
   - Output Directory: `dist`

2. **Environment Variables:**
   - Ensure all required environment variables are set in Vercel dashboard

3. **Clear Vercel Cache:**
   - In Vercel dashboard, go to Settings → Functions
   - Clear the build cache

## Testing Locally

To test the build locally:
```bash
npm run build
npm run preview
```

This should replicate the production environment and help identify any issues.
