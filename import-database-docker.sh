#!/bin/bash

# Check if pg_restore is installed
# if ! command -v pg_restore &> /dev/null; then
#   echo "pg_restore could not be found"
#   exit
# fi

source ./.env.local

# Access the variables from the .env file
DOCKER_CONTAINER_NAME="photo-good-database-1" # Replace with your PostgreSQL container name
DATABASE_HOST=$DATABASE_HOST
DATABASE_NAME=$POSTGRES_DATABASE
POSTGRES_USER=$POSTGRES_USER
POSTGRES_PASSWORD=$POSTGRES_PASSWORD

export PGPASSWORD=$POSTGRES_PASSWORD

echo "Restoring database to PostgreSQL in Docker container ($DOCKER_CONTAINER_NAME)..."

# Drop and recreate the public schema inside the container
docker exec -i $DOCKER_CONTAINER_NAME psql -U $POSTGRES_USER -d $DATABASE_NAME -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Get the database dump file from parameter, default to database.sql
DB_FILE=${1:-database.sql}

# Restore the database using a .sql file
docker exec -i $DOCKER_CONTAINER_NAME psql -U $POSTGRES_USER -d $DATABASE_NAME < "$DB_FILE"

# Unset all environment variables
unset PGPASSWORD

echo "Database restore complete."

# Build and start the strapi service
# docker compose -f docker-compose.yml -f docker-compose.dev.yml build --no-cache strapi
# docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d strapi
