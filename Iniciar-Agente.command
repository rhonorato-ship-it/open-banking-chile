#!/bin/bash
# Iniciar Agente — open-banking-chile
# Double-click this file in macOS Finder to start the sync agent.

cd "$(dirname "$0")"

# Use local node_modules if available, otherwise use npx
if [ -f "dist/cli.js" ]; then
  node dist/cli.js serve
else
  npx open-banking-chile@latest serve
fi
