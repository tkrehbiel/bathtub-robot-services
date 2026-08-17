#!/usr/bin/env node

const { execSync } = require('child_process');

function parseDuration(since) {
  const match = since.match(/^(\d+)([smhd])$/);
  if (!match) return 15 * 60 * 1000; // default 15m
  const val = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's': return val * 1000;
    case 'm': return val * 60 * 1000;
    case 'h': return val * 60 * 1000 * 60;
    case 'd': return val * 24 * 60 * 1000 * 60;
    default: return 15 * 60 * 1000;
  }
}

function runAwsCommand(args, endpointUrl) {
  const cmd = `aws ${endpointUrl ? `--endpoint-url=${endpointUrl}` : ''} ${args.join(' ')}`;
  try {
    const stdout = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout.toString());
  } catch (err) {
    // If the log group doesn't exist yet, return empty
    return { events: [] };
  }
}

function main() {
  const args = process.argv.slice(2);
  let stage = 'local';
  let sinceStr = '15m';
  let endpointUrl = 'http://localhost:4566';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prod') {
      stage = 'prod';
      endpointUrl = null;
    } else if (args[i] === '--local') {
      stage = 'local';
      endpointUrl = 'http://localhost:4566';
    } else if (args[i] === '--stage') {
      stage = args[++i];
      if (stage !== 'local') {
        endpointUrl = null;
      }
    } else if (args[i] === '--since') {
      sinceStr = args[++i];
    }
  }

  const durationMs = parseDuration(sinceStr);
  const startTime = Date.now() - durationMs;

  const webmentionGroup = `/aws/lambda/bathtub-robot-services-${stage}-webmention-sender`;
  const pingbackGroup = `/aws/lambda/bathtub-robot-services-${stage}-pingback-sender`;

  const webmentionLogs = runAwsCommand(['logs', 'filter-log-events', '--log-group-name', webmentionGroup, '--start-time', startTime], endpointUrl);
  const pingbackLogs = runAwsCommand(['logs', 'filter-log-events', '--log-group-name', pingbackGroup, '--start-time', startTime], endpointUrl);

  const entries = [];

  // Group log lines by RequestId using logStreamName state tracking
  const currentReqWebmention = {}; // streamName -> reqId
  const webmentionMap = {};       // reqId -> data

  const webmentionEvents = webmentionLogs.events || [];
  for (const ev of webmentionEvents) {
    const msg = ev.message;
    const ts = ev.timestamp;
    const stream = ev.logStreamName;

    const startMatch = msg.match(/START RequestId:\s*([a-f0-9-]+)/);
    if (startMatch) {
      const reqId = startMatch[1];
      currentReqWebmention[stream] = reqId;
      webmentionMap[reqId] = { timestamp: ts, type: 'Webmention' };
      continue;
    }

    const reqId = currentReqWebmention[stream];
    if (!reqId) continue;

    if (msg.includes('Starting webmention processing')) {
      const match = msg.match(/from\s+(\S+)\s+to\s+(\S+)/);
      if (match) {
        webmentionMap[reqId].source = match[1];
        webmentionMap[reqId].target = match[2];
      }
    } else if (msg.includes('Discovered webmention endpoint')) {
      const match = msg.match(/endpoint\s+(\S+)\s+for\s+(\S+)/);
      if (match) {
        webmentionMap[reqId].endpoint = match[1];
      }
    } else if (msg.includes('Bypassing webmention dispatch')) {
      webmentionMap[reqId].status = 'Sent (Bypassed)';
    } else if (msg.includes('Successfully sent webmention')) {
      webmentionMap[reqId].status = 'Sent (Success)';
    } else if (msg.includes('Failed to discover webmention endpoint')) {
      const match = msg.match(/Failed to discover webmention endpoint for \S+:\s*(.*)/);
      webmentionMap[reqId].status = 'Ignored (' + (match ? match[1].trim() : 'endpoint not found') + ')';
    } else if (msg.includes('Failed to send webmention')) {
      const match = msg.match(/Failed to send webmention:\s*(.*)/);
      webmentionMap[reqId].status = 'Failed (' + (match ? match[1].trim() : 'send error') + ')';
    }
  }

  const currentReqPingback = {}; // streamName -> reqId
  const pingbackMap = {};       // reqId -> data

  const pingbackEvents = pingbackLogs.events || [];
  for (const ev of pingbackEvents) {
    const msg = ev.message;
    const ts = ev.timestamp;
    const stream = ev.logStreamName;

    const startMatch = msg.match(/START RequestId:\s*([a-f0-9-]+)/);
    if (startMatch) {
      const reqId = startMatch[1];
      currentReqPingback[stream] = reqId;
      pingbackMap[reqId] = { timestamp: ts, type: 'Pingback' };
      continue;
    }

    const reqId = currentReqPingback[stream];
    if (!reqId) continue;

    if (msg.includes('Starting pingback processing')) {
      const match = msg.match(/from\s+(\S+)\s+to\s+(\S+)/);
      if (match) {
        pingbackMap[reqId].source = match[1];
        pingbackMap[reqId].target = match[2];
      }
    } else if (msg.includes('Discovered pingback endpoint')) {
      const match = msg.match(/endpoint\s+(\S+)\s+for\s+(\S+)/);
      if (match) {
        pingbackMap[reqId].endpoint = match[1];
      }
    } else if (msg.includes('Bypassing pingback dispatch')) {
      pingbackMap[reqId].status = 'Sent (Bypassed)';
    } else if (msg.includes('Successfully sent pingback')) {
      pingbackMap[reqId].status = 'Sent (Success)';
    } else if (msg.includes('supports Webmention. Skipping pingback dispatch')) {
      pingbackMap[reqId].status = 'Skipped (Webmention Supported)';
    } else if (msg.includes('Failed to discover pingback endpoint')) {
      const match = msg.match(/Failed to discover pingback endpoint for \S+:\s*(.*)/);
      pingbackMap[reqId].status = 'Ignored (' + (match ? match[1].trim() : 'endpoint not found') + ')';
    } else if (msg.includes('Failed to send pingback')) {
      const match = msg.match(/Failed to send pingback:\s*(.*)/);
      pingbackMap[reqId].status = 'Failed (' + (match ? match[1].trim() : 'send error') + ')';
    }
  }

  // Collect map entries
  for (const key of Object.keys(webmentionMap)) {
    const entry = webmentionMap[key];
    if (entry.source && entry.target) {
      entries.push(entry);
    }
  }
  for (const key of Object.keys(pingbackMap)) {
    const entry = pingbackMap[key];
    if (entry.source && entry.target) {
      entries.push(entry);
    }
  }

  // Sort by timestamp
  entries.sort((a, b) => a.timestamp - b.timestamp);

  // Generate Markdown
  if (entries.length === 0) {
    console.log(`No outgoing mentions logged in the last ${sinceStr} for stage "${stage}".`);
    return;
  }

  console.log(`### Outgoing Mentions Log (Stage: ${stage}, Since: ${sinceStr})`);
  console.log();
  console.log('| Timestamp (UTC) | Source Post | Target Link | Protocol | Discovered Endpoint | Status / Action |');
  console.log('| :--- | :--- | :--- | :--- | :--- | :--- |');

  for (const entry of entries) {
    const dateStr = new Date(entry.timestamp).toISOString().replace('T', ' ').substring(0, 19);
    const sourceShort = entry.source.replace('https://endgameviable.com/post/', 'post:');
    const targetShort = entry.target.length > 50 ? entry.target.substring(0, 47) + '...' : entry.target;
    const endpointStr = entry.endpoint || '*None*';
    const statusStr = entry.status || 'Processing';
    console.log(`| ${dateStr} | [${sourceShort}](${entry.source}) | [${targetShort}](${entry.target}) | ${entry.type} | ${endpointStr} | ${statusStr} |`);
  }
}

main();
