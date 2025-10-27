#!/bin/bash

# Automated Deployment Script
# Includes detailed timing to record total time and time spent on each step

set -e  # Exit on error

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Global variables
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="zheyuan_wei2003@34.130.69.135"
IMAGE_NAME="zheyuanwei/w2w:latest"

# Step counter
STEP=0
declare -A STEP_TIMES

# Timing functions
start_time=$(date +%s)

step_start() {
    STEP=$((STEP + 1))
    step_name=$1
    step_start_time=$(date +%s)
    echo -e "${BLUE}[Step $STEP]${NC} ${CYAN}$step_name${NC}..."
}

step_end() {
    step_end_time=$(date +%s)
    elapsed=$((step_end_time - step_start_time))
    STEP_TIMES[$STEP]=$elapsed
    printf "  ${GREEN}✓ Done${NC} (Elapsed: ${YELLOW}${elapsed}s${NC})\n\n"
}

step_error() {
    step_end_time=$(date +%s)
    elapsed=$((step_end_time - step_start_time))
    printf "  ${RED}✗ Failed${NC} (Elapsed: ${elapsed}s)\n"
    exit 1
}

print_header() {
    echo -e "${CYAN}======================================${NC}"
    echo -e "${CYAN}    Automated Deployment Script v1.0${NC}"
    echo -e "${CYAN}======================================${NC}"
    echo -e "Start Time: ${GREEN}$(date '+%Y-%m-%d %H:%M:%S')${NC}"
    echo -e "Image: ${YELLOW}$IMAGE_NAME${NC}"
    echo -e "Server: ${YELLOW}$SERVER${NC}"
    echo ""
}

print_footer() {
    end_time=$(date +%s)
    total_time=$((end_time - start_time))
    
    echo ""
    echo -e "${CYAN}======================================${NC}"
    echo -e "${GREEN}    Deployment Complete!${NC}"
    echo -e "${CYAN}======================================${NC}"
    echo -e "End Time: ${GREEN}$(date '+%Y-%m-%d %H:%M:%S')${NC}"
    echo ""
    echo -e "${YELLOW}Time Statistics:${NC}"
    for step in $(seq 1 $STEP); do
        printf "  Step $step: ${GREEN}%ds${NC}\n" "${STEP_TIMES[$step]}"
    done
    echo ""
    printf "  ${YELLOW}Total Time: ${GREEN}%ds${NC} (~ %dm%ds)\n" "$total_time" $((total_time / 60)) $((total_time % 60))
    echo ""
}

print_header

# Step 1: Build and push Docker image
step_start "Building Docker image (amd64)"
cd "$SCRIPT_DIR"
if docker buildx build --platform=linux/amd64 -t "$IMAGE_NAME" --push . > /tmp/deploy-build.log 2>&1; then
    step_end
else
    echo -e "${RED}Build failed, check logs: /tmp/deploy-build.log${NC}"
    step_error
fi

# Step 2: Update server
step_start "SSH connection and pull latest image"
if ssh "$SERVER" "cd ~/CSCC09-24F-Project/remix && docker-compose pull" > /tmp/deploy-pull.log 2>&1; then
    step_end
else
    echo -e "${RED}Pull failed${NC}"
    step_error
fi

step_start "Stopping old containers"
ssh "$SERVER" "cd ~/CSCC09-24F-Project/remix && docker-compose down" > /tmp/deploy-down.log 2>&1
step_end

step_start "Starting new containers"
if ssh "$SERVER" "cd ~/CSCC09-24F-Project/remix && docker-compose up -d" > /tmp/deploy-up.log 2>&1; then
    step_end
else
    echo -e "${RED}Startup failed${NC}"
    step_error
fi

step_start "Verifying container status"
ssh "$SERVER" "docker ps" | grep -E "remix|redis|nginx-proxy|nginx-proxy-acme"
step_end

# Display detailed container status
echo -e "${CYAN}Detailed Container Status:${NC}"
ssh "$SERVER" "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"

print_footer
