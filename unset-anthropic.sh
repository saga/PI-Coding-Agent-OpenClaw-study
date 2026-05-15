#!/bin/bash
for var in $(env | grep '^ANTHROPIC_' | cut -d= -f1); do
    unset "$var"
    echo "unset $var"
done
