#!/usr/bin/env bash

set -u

DURATION="${1:-20}"
RATE="${2:-20}"
TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
OUTPUT_DIR="$HOME/Desktop/qortal-python-profile-$TIMESTAMP"

if ! command -v py-spy >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
        echo "Installing py-spy..."
        brew install py-spy || exit 1
    else
        echo "Homebrew is unavailable. Install py-spy manually."
        exit 1
    fi
fi

PYSPY="$(command -v py-spy)"
mkdir -p "$OUTPUT_DIR"

# Anchored patterns prevent the script, Codex, grep, and py-spy itself
# from being mistaken for Qortal processes.
BRIDGE_PIDS="$(
    pgrep -f '^/Applications/.*/Python .*\/presence_bridge\.py --config ' || true
)"

RNSD_PIDS="$(
    pgrep -f '^/Applications/.*/Python .*\/rnsd --config ' || true
)"

if [ -z "$BRIDGE_PIDS" ] && [ -z "$RNSD_PIDS" ]; then
    echo "No Qortal presence_bridge or rnsd processes were found."
    echo "Start Qortal Hub and run this script again."
    exit 1
fi

echo "Output directory: $OUTPUT_DIR"
echo "Bridge PIDs: ${BRIDGE_PIDS:-none}"
echo "rnsd PIDs: ${RNSD_PIDS:-none}"
echo
echo "Requesting administrator access..."

sudo -v || exit 1

{
    echo "Captured: $(date)"
    echo "Duration: ${DURATION}s"
    echo "Rate: ${RATE} samples/second"
    echo "py-spy: $PYSPY"
    echo
    uname -a
    echo
    echo "Qortal Python processes:"
    for pid in $BRIDGE_PIDS $RNSD_PIDS; do
        ps -p "$pid" -o pid=,ppid=,%cpu=,etime=,command=
    done
} > "$OUTPUT_DIR/system-info.txt"

capture_process() {
    local label="$1"
    local pid="$2"
    local profile="$OUTPUT_DIR/${label}-${pid}-profile.json"
    local log="$OUTPUT_DIR/${label}-${pid}-profile.log"
    local threads="$OUTPUT_DIR/${label}-${pid}-threads.txt"
    local fallback="$OUTPUT_DIR/${label}-${pid}-macos-sample.txt"

    echo "Preparing $label PID $pid..."

    ps -p "$pid" -o pid=,ppid=,%cpu=,etime=,command= \
        > "$OUTPUT_DIR/${label}-${pid}-process.txt"

    sudo "$PYSPY" dump \
        --nonblocking \
        --pid "$pid" \
        > "$threads" 2>&1 || true

    (
        sudo "$PYSPY" record \
            --nonblocking \
            --rate "$RATE" \
            --duration "$DURATION" \
            --pid "$pid" \
            --format speedscope \
            --output "$profile" \
            > "$log" 2>&1

        if [ ! -s "$profile" ]; then
            echo "py-spy failed; collecting macOS sample fallback." >> "$log"
            sample "$pid" "$DURATION" 10 -file "$fallback" \
                >> "$log" 2>&1 || true
        fi
    ) &
}

for pid in $BRIDGE_PIDS; do
    capture_process "presence-bridge" "$pid"
done

for pid in $RNSD_PIDS; do
    capture_process "rnsd" "$pid"
done

echo
echo "Recording simultaneously for ${DURATION} seconds..."
wait

echo
echo "Capture results:"
find "$OUTPUT_DIR" -type f -maxdepth 1 -exec ls -lh {} \;

ZIP_PATH="$OUTPUT_DIR.zip"

ditto -c -k --sequesterRsrc --keepParent \
    "$OUTPUT_DIR" "$ZIP_PATH"

echo
echo "Finished: $ZIP_PATH"