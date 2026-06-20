#! /bin/bash

source ./.env.production

# Access the variables from arg
TUNNEL_CREDENTIALS=$1

if [ -z "$TUNNEL_CREDENTIALS" ]
then
  echo "Please provide the tunnel credentials as an argument"
  exit
fi

# Access the variables from the production.env file
PROD_DATABASE_HOST=$DATABASE_HOST
PROD_DATABASE_NAME=$POSTGRES_DATABASE
PROD_POSTGRES_ROOT_USER=$POSTGRES_USER
PROD_POSTGRES_ROOT_PASSWORD=$POSTGRES_PASSWORD

export PGPASSWORD=$PROD_POSTGRES_ROOT_PASSWORD

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILENAME="database_${TIMESTAMP}.sql"

echo "Pulling database from $PROD_DATABASE_HOST"

REMOTE_DB_CONTAINER=photo-good-database-1

ssh "$TUNNEL_CREDENTIALS" \
  "docker exec -e PGPASSWORD='$PROD_POSTGRES_ROOT_PASSWORD' $REMOTE_DB_CONTAINER pg_dump -U '$PROD_POSTGRES_ROOT_USER' -d '$PROD_DATABASE_NAME'" \
  > ./$BACKUP_FILENAME

if [ $? -ne 0 ]; then
  echo "Database dump failed"
  exit 1
fi

# unset all env vars
unset PGPASSWORD
unset PROD_DATABASE_HOST
unset PROD_DATABASE_NAME
unset PROD_POSTGRES_ROOT_USER
unset PROD_POSTGRES_ROOT_PASSWORD

echo "Database dump complete: ./$BACKUP_FILENAME"