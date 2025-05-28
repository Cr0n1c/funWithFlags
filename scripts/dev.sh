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

# Start nodemon for server.ts and redirect output to a log file
nodemon --watch src --ext 'ts' --exec 'NODE_OPTIONS="--loader ts-node/esm" ts-node src/server.ts' > server.log 2>&1 &

# Start nodemon for build:dev
nodemon --watch src --ext '*' --exec 'npm run build:dev' & 
http-server dist -p 8888 -c no-store &

# Wait for both processes
wait 