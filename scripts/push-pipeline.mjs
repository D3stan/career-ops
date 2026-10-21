#!/usr/bin/env node
/**
 * push-pipeline.mjs — Push local scan offers or pipeline entries to a remote VPS ingest API.
 *
 * Usage:
 *   node scripts/push-pipeline.mjs --remote https://<vps-url> --token <secret> [--file <path>]
 *   cat offers.json | node scripts/push-pipeline.mjs --remote https://<vps-url> --token <secret>
 *
 * Env fallbacks:
 *   CAREER_OPS_REMOTE_URL     Target VPS base URL (e.g. https://my-vps.example.com)
 *   CAREER_OPS_WEBHOOK_SECRET Ingestion bearer secret token
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const USAGE = `Usage:
  node scripts/push-pipeline.mjs --remote <url> --token <secret> [--file <path>] [--source <name>] [--dry-run]

Options:
  --remote <url>    Target remote VPS URL (or set CAREER_OPS_REMOTE_URL)
  --token <secret>  Ingestion bearer webhook secret (or set CAREER_OPS_WEBHOOK_SECRET)
  --file <path>     Path to JSON file or markdown pipeline.md with checkboxes (default: stdin)
  --source <name>   Source identifier (default: "mac-scanner")
  --dry-run         Parse the input and print what would be pushed; no network call
  --help, -h        Show this help message
`;

export function parseArgs(args) {
  const result = {
    remote: process.env.CAREER_OPS_REMOTE_URL || '',
    token: process.env.CAREER_OPS_WEBHOOK_SECRET || '',
    file: '',
    source: 'mac-scanner',
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--remote') {
      result.remote = args[++i] || '';
    } else if (arg.startsWith('--remote=')) {
      result.remote = arg.slice('--remote='.length);
    } else if (arg === '--token') {
      result.token = args[++i] || '';
    } else if (arg.startsWith('--token=')) {
      result.token = arg.slice('--token='.length);
    } else if (arg === '--file') {
      result.file = args[++i] || '';
    } else if (arg.startsWith('--file=')) {
      result.file = arg.slice('--file='.length);
    } else if (arg === '--source') {
      result.source = args[++i] || 'mac-scanner';
    } else if (arg.startsWith('--source=')) {
      result.source = arg.slice('--source='.length);
    }
  }

  return result;
}

export function parseMarkdownPipeline(text) {
  const jobs = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const match = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (!match) continue;
    const body = match[2];
    const rawParts = body.split('|').map(s => s.trim());
    if (rawParts.length === 0) continue;

    const url = rawParts[0];
    if (!/^https?:\/\//i.test(url)) continue;

    // Remaining parts: filter out labeled segments like `posted: 2026-01-01`, `trust: ...`, `note: ...`
    const positional = [];
    for (let i = 1; i < rawParts.length; i++) {
      const part = rawParts[i];
      if (/^[a-z_-]+:\s*/i.test(part)) {
        continue; // labeled segment
      }
      positional.push(part);
    }

    const company = positional[0] || '';
    const role = positional[1] || '';
    const location = positional[2] || undefined;
    const compensation = positional[3] || undefined;

    if (company && role) {
      jobs.push({
        url,
        company,
        role,
        location: location || undefined,
        compensation: compensation || undefined,
      });
    }
  }

  return jobs;
}

export function parseInputContent(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // Try parsing as JSON first
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.jobs)) {
      return parsed.jobs;
    }
  } catch {
    // Not valid JSON, try markdown checkbox format
  }

  return parseMarkdownPipeline(trimmed);
}

export async function pushJobs({ remote, token, source = 'mac-scanner', jobs, fetchFn = fetch }) {
  if (!remote) {
    throw new Error('Remote URL missing. Provide --remote <url> or set CAREER_OPS_REMOTE_URL.');
  }
  if (!token) {
    throw new Error('Webhook token missing. Provide --token <secret> or set CAREER_OPS_WEBHOOK_SECRET.');
  }
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return { ok: true, received: 0, added: 0, skippedDuplicates: 0 };
  }

  const endpoint = `${remote.replace(/\/+$/, '')}/api/pipeline/ingest`;
  const payload = {
    source: source || 'mac-scanner',
    jobs,
  };

  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Remote ingestion error (${res.status}): ${errText}`);
  }

  return await res.json();
}

async function readStream(stream) {
  let content = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    content += chunk;
  }
  return content;
}

export async function main() {
  const { remote, token, file, source, dryRun } = parseArgs(process.argv.slice(2));

  if (!remote && !dryRun) {
    console.error('Error: Remote URL missing. Provide --remote <url> or set CAREER_OPS_REMOTE_URL.\n');
    console.error(USAGE);
    process.exit(1);
  }

  if (!token && !dryRun) {
    console.error('Error: Webhook token missing. Provide --token <secret> or set CAREER_OPS_WEBHOOK_SECRET.\n');
    console.error(USAGE);
    process.exit(1);
  }

  let content = '';
  if (file) {
    if (!fs.existsSync(file)) {
      console.error(`Error: File not found: ${file}`);
      process.exit(1);
    }
    content = fs.readFileSync(file, 'utf8');
  } else if (!process.stdin.isTTY) {
    content = await readStream(process.stdin);
  } else {
    console.error('Error: No input provided via --file or stdin.\n');
    console.error(USAGE);
    process.exit(1);
  }

  const jobs = parseInputContent(content);
  if (jobs.length === 0) {
    console.log('No valid jobs found to push.');
    process.exit(0);
  }

  if (dryRun) {
    console.log(`Dry run: ${jobs.length} offer(s) would be pushed (source: ${source}).`);
    for (const j of jobs) console.log(`  ${j.url} | ${j.company} | ${j.role || j.title || ''}`);
    process.exit(0);
  }

  const endpoint = `${remote.replace(/\/+$/, '')}/api/pipeline/ingest`;
  console.log(`Pushing ${jobs.length} offer(s) to ${endpoint}...`);

  try {
    const data = await pushJobs({ remote, token, source, jobs });
    console.log(`Push successful: ${data.received} received, ${data.added} added, ${data.skippedDuplicates} duplicates skipped.`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

// Run main if executed directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`Unexpected error: ${err.message}`);
    process.exit(1);
  });
}
