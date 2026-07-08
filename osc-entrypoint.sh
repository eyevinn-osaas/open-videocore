#!/bin/sh
set -e

# Map OSC_HOSTNAME to PUBLIC_BASE_URL so Encore profile loading works correctly
if [ -n "$OSC_HOSTNAME" ]; then
  export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://$OSC_HOSTNAME}"
fi

exec "$@"