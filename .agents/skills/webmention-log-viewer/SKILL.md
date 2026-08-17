---
name: webmention-log-viewer
description: >-
  Use this skill when the user wants to check, retrieve, or audit outgoing linkbacks
  (Webmentions and Pingbacks) processed by the system. It can retrieve logs from both
  the local LocalStack stage and production AWS stages.
---

# Webmention Log Viewer Skill

This skill retrieves, parses, and consolidates the execution logs of the `webmention-sender` and `pingback-sender` microservices. It automatically groups log lines by Request ID, resolves statuses (Sent, Bypassed, Skipped, Ignored), and generates a chronological markdown table of outgoing mentions.

## Usage

You can run the log-checking tool using the Node.js script located in the skill's scripts directory:

[check-logs.cjs](./scripts/check-logs.cjs)

### Parameters

- `--local` (default): Query local LocalStack log groups using endpoint `http://localhost:4566`.
- `--prod` / `--stage <stage>`: Query production or a specific AWS stage log group directly (uses your default AWS CLI credentials).
- `--since <duration>` (default `15m`): Filter logs to the specified duration. The format is a number followed by `s`, `m`, `h`, or `d` (e.g., `30s`, `15m`, `2h`, `1d`).

### Command Examples

#### 1. Checking Local Mentions (Last 15 Minutes)
```bash
node .agents/skills/webmention-log-viewer/scripts/check-logs.cjs
```

#### 2. Checking Local Mentions (Last 2 Hours)
```bash
node .agents/skills/webmention-log-viewer/scripts/check-logs.cjs --since 2h
```

#### 3. Checking Production Mentions (Last 24 Hours)
```bash
node .agents/skills/webmention-log-viewer/scripts/check-logs.cjs --prod --since 24h
```

#### 4. Checking Dev Stage Mentions (Last 1 Hour)
```bash
node .agents/skills/webmention-log-viewer/scripts/check-logs.cjs --stage dev --since 1h
```
