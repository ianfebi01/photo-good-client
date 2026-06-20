#!/bin/bash

REPO="ianfebi01/photo-good"  # 🔁 Replace with your target repo
ENV_FILE=".env.production"

while IFS='=' read -r key value
do
  if [[ ! $key =~ ^# && $key ]]; then
    echo "🔐 Uploading $key..."
    gh secret set "$key" --repo "$REPO" --body "$value"
  fi
done < "$ENV_FILE"

echo "✅ All secrets uploaded to $REPO"
