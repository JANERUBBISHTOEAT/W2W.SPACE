#!/bin/bash

# Server update script
# Run this on the server

cd /root

# Pull latest docker images
docker-compose pull

# Stop all containers
docker-compose down

# Restart all containers with new images
docker-compose up -d

# Clean up old/unused images
docker image prune -f

echo "Update complete!"

