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

# Start the server in the background
npm run start:server &

# Start the development server
npm run build:dev
http-server dist -p 8888 -d false

# Wait for both processes
wait 