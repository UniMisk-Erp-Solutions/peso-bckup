#!/usr/bin/env bash
docker exec pesowise-react-migration-staging sh -c '
for p in 54321 pesowise-supabase rest/v1 auth/v1 storage/v1; do
  n=$(grep -ro "$p" /usr/share/nginx/html/assets/*.js 2>/dev/null | wc -l)
  echo "bundle_hits_${p}=$n"
done
'
