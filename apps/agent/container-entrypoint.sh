#!/bin/sh
set -eu

cd /app/apps/agent
./node_modules/.bin/drizzle-kit migrate --config=drizzle.config.ts
exec node dist/server.js
