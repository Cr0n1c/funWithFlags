#!/bin/bash

# Function to cleanup processes
cleanup() {
    echo "Shutting down development server..."
    pkill -f nodemon
    pkill -f http-server
    exit 0
}

# Set up trap for cleanup
trap cleanup SIGINT SIGTERM

# Start nodemon and http-server
nodemon --watch src --ext '*' --exec 'npm run build:dev' & 
http-server dist -p 8888 -c no-store &

# Wait for both processes
wait 