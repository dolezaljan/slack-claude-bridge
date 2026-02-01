import Bolt from '@slack/bolt';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, createWriteStream, rmSync, readdirSync } from 'fs';
import { pipeline } from 'stream/promises';
import { createHash } from 'crypto';

const { App } = Bolt;

// Configuration
const CONFIG_DIR = process.env.HOME + '/.claude/slack-bridge';

// Timing constants (milliseconds)
const TIMING = {
  CLAUDE_READY_TIMEOUT: 15000,      // Max wait for Claude to show prompt
  CLAUDE_READY_POLL: 300,           // Poll interval when waiting for Claude
  CLAUDE_READY_SETTLE: 200,         // Extra wait after Claude ready for UI stability
  TRUST_PROMPT_DELAY: 2000,         // Delay before auto-confirming trust prompt
  FILE_PASTE_DELAY: 1000,           // Wait between file pastes for Claude to process
  ENTER_KEY_DELAY: 100,             // Delay before sending second Enter
  WINDOW_CREATE_DELAY: 100,         // Wait for tmux window creation
  FILE_DOWNLOAD_TIMEOUT: 30000,     // Timeout for downloading Slack files
  IDLE_CHECK_INTERVAL: 60000,       // How often to check for idle sessions
  HEALTH_CHECK_INTERVAL: 30000,     // How often to check for crashed sessions
  TEMP_CLEANUP_INTERVAL: 86400000,  // How often to clean temp files (24h)
};
const SESSIONS_FILE = '/tmp/claude-slack-sessions.json';
const SESSIONS_LOCK = '/tmp/claude-slack-sessions.lock';

// Load tokens from config file
function loadConfig() {
  const configPath = `${CONFIG_DIR}/config.json`;
  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    console.error('Create it with: {"botToken": "xoxb-...", "appToken": "xapp-...", "allowedUsers": ["U..."]}');
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));

  // Set defaults for multiSession config
  config.multiSession = config.multiSession || {};
  config.multiSession.maxConcurrent = config.multiSession.maxConcurrent || 5;
  config.multiSession.idleTimeoutMinutes = config.multiSession.idleTimeoutMinutes || 60;
  // Whether to notify when session times out (default: false)
  config.multiSession.notifyOnTimeout = config.multiSession.notifyOnTimeout || false;
  config.multiSession.tmuxSession = config.multiSession.tmuxSession || 'claude';
  config.multiSession.defaultWorkingDir = config.multiSession.defaultWorkingDir || '~';
  // How long to keep temp files (downloaded attachments) before cleanup
  config.multiSession.tempFileRetentionDays = config.multiSession.tempFileRetentionDays || 14;

  return config;
}

// Acquire exclusive lock to prevent multiple instances with same config
function acquireInstanceLock(botToken) {
  // Create lock file name based on hash of bot token (so different configs can run)
  const tokenHash = createHash('sha256').update(botToken).digest('hex').substring(0, 16);
  const lockFile = `/tmp/claude-slack-bridge-${tokenHash}.lock`;

  // Check if lock file exists and if the process is still running
  if (existsSync(lockFile)) {
    try {
      const pid = readFileSync(lockFile, 'utf-8').trim();
      // Check if process is still running
      execSync(`kill -0 ${pid} 2>/dev/null`);
      // Process is running
      console.error(`Another bridge instance is already running (PID: ${pid})`);
      console.error(`Lock file: ${lockFile}`);
      console.error('Stop the other instance first, or remove the lock file if stale.');
      process.exit(1);
    } catch {
      // Process not running, stale lock file - remove it
      console.log(`Removing stale lock file (previous PID: ${readFileSync(lockFile, 'utf-8').trim()})`);
    }
  }

  // Write our PID to lock file
  writeFileSync(lockFile, `${process.pid}\n`);

  // Clean up lock file on exit
  const cleanup = () => {
    try {
      // Only remove if it's our PID
      if (existsSync(lockFile) && readFileSync(lockFile, 'utf-8').trim() === `${process.pid}`) {
        execSync(`rm -f ${lockFile}`);
      }
    } catch {}
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  return lockFile;
}

const config = loadConfig();

// Prevent multiple instances with same config
acquireInstanceLock(config.botToken);

const TMUX_SESSION = config.multiSession.tmuxSession;

// Initialize Slack app with Socket Mode
const app = new App({
  token: config.botToken,
  appToken: config.appToken,
  socketMode: true,
});

// Workspace URL for thread links (fetched at startup)
let workspaceUrl = '';

// ============================================
// Session Management
// ============================================

// Track window index for temporary names (start at 1 since window 0 is bridge)
// Initialize by scanning existing windows to avoid conflicts after restart
function initWindowIndex() {
  let maxIndex = 0;
  try {
    const windows = execSync(`tmux list-windows -t ${TMUX_SESSION} -F '#{window_name}' 2>/dev/null`, { encoding: 'utf-8' });
    for (const name of windows.split('\n')) {
      const match = name.match(/^new-(\d+)$/);
      if (match) {
        maxIndex = Math.max(maxIndex, parseInt(match[1], 10));
      }
    }
  } catch {
    // tmux session may not exist yet
  }
  return maxIndex + 1;
}

let windowIndex = initWindowIndex();

// In-memory lock to prevent duplicate session creation
const creatingSession = new Map();  // threadTs → Promise

function loadSessions() {
  try {
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSessions(sessions) {
  const json = JSON.stringify(sessions, null, 2);
  console.log(`[${new Date().toISOString()}] Saving sessions, keys: ${Object.keys(sessions).join(', ')}`);
  // Use flock for atomic write with locking (coordinates with hooks)
  execSync(`flock ${SESSIONS_LOCK} -c 'cat > ${SESSIONS_FILE}'`, { input: json });
}

// Lock to prevent race condition on simultaneous session creation
async function withSessionLock(threadTs, createFn) {
  // If already creating, wait for it
  if (creatingSession.has(threadTs)) {
    await creatingSession.get(threadTs);
    return null;  // Signal that session was created by another call
  }

  // Create a promise that resolves when we're done
  let resolve;
  const promise = new Promise(r => resolve = r);
  creatingSession.set(threadTs, promise);

  try {
    return await createFn();
  } finally {
    creatingSession.delete(threadTs);
    resolve();
  }
}

// ============================================
// Working Directory Handling
// ============================================

// Parse [/path/to/dir] prefix from message
function parseWorkingDir(text) {
  const match = text.match(/^\[([^\]]+)\]\s*/);
  if (match) {
    return {
      requestedPath: match[1],
      message: text.slice(match[0].length)
    };
  }
  return { requestedPath: null, message: text };
}

// Validate and resolve working directory
function resolveWorkingDir(requestedPath) {
  const defaultDir = config.multiSession.defaultWorkingDir.replace(/^~/, process.env.HOME);

  if (!requestedPath) {
    return { path: defaultDir, warning: null };
  }

  const resolved = requestedPath.replace(/^~/, process.env.HOME);

  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return { path: defaultDir, warning: `⚠️ Path is not a directory: \`${requestedPath}\`, using default` };
    }
    return { path: resolved, warning: null };
  } catch (e) {
    return { path: defaultDir, warning: `⚠️ Path not found: \`${requestedPath}\`, using default` };
  }
}

// ============================================
// tmux Helpers
// ============================================

// Check if tmux session exists
function tmuxSessionExists() {
  try {
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

// Check if tmux window exists (without switching to it)
function tmuxWindowExists(windowName) {
  try {
    const windows = execSync(`tmux list-windows -t ${TMUX_SESSION} -F '#{window_name}'`, { encoding: 'utf-8' });
    return windows.split('\n').includes(windowName);
  } catch {
    return false;
  }
}

// Capture tmux pane content
function capturePaneContent(windowName) {
  try {
    return execSync(`tmux capture-pane -t ${TMUX_SESSION}:${windowName} -p`, { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

// Wait for Claude to be ready (shows prompt after trust prompt is confirmed)
async function waitForClaudeReady(windowName, maxWaitMs = TIMING.CLAUDE_READY_TIMEOUT) {
  const startTime = Date.now();
  const pollInterval = TIMING.CLAUDE_READY_POLL;

  while (Date.now() - startTime < maxWaitMs) {
    const content = capturePaneContent(windowName);

    // Skip if still showing trust prompt (waiting for confirmation)
    if (content.includes('trust this folder') || content.includes('Yes, I trust')) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      continue;
    }

    // Check for ready indicators (after trust is confirmed)
    if (content.includes('Welcome') ||      // "Welcome back" or "Welcome to Claude"
        content.includes('❯') ||            // Prompt ready
        content.includes('What would you like to do?')) {  // Initial prompt
      console.log(`[${new Date().toISOString()}] Claude ready in window ${windowName}`);
      // Wait for UI to stabilize before sending input
      await new Promise(resolve => setTimeout(resolve, TIMING.CLAUDE_READY_SETTLE));
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  console.log(`[${new Date().toISOString()}] Timeout waiting for Claude in window ${windowName}`);
  return false;
}

// Send text to a tmux window
async function sendToWindow(windowName, text) {
  // Check if this is an option with additional instructions (e.g., "1 but only this file" or "3 try something else")
  const optionParsed = parseOptionWithInstructions(text);
  if (optionParsed.hasInstructions) {
    const optionNum = parseInt(optionParsed.optionKey, 10);
    console.log(`[${new Date().toISOString()}] Option ${optionNum} with instructions: "${optionParsed.instructions.substring(0, 50)}..."`);

    // Navigate to the option using Down arrow (option 1 is default)
    // Pressing digit immediately confirms, so we must use arrow navigation for Tab to work
    if (optionNum > 1) {
      for (let i = 1; i < optionNum; i++) {
        execSync(`tmux send-keys -t ${TMUX_SESSION}:${windowName} Down`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      // Small delay after navigation before Tab
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Press Tab to open amendment input
    execSync(`tmux send-keys -t ${TMUX_SESSION}:${windowName} Tab`);
    await new Promise(resolve => setTimeout(resolve, 500));

    // Type the instructions
    const escapedInstructions = optionParsed.instructions.replace(/'/g, "'\\''");
    execSync(`tmux send-keys -t ${TMUX_SESSION}:${windowName} -l '${escapedInstructions}'`);

    // Wait for text to be processed, then Enter to confirm
    await new Promise(resolve => setTimeout(resolve, 500));
    execSync(`tmux send-keys -t ${TMUX_SESSION}:${windowName} Enter`);
    console.log(`[${new Date().toISOString()}] Option ${optionNum} with instructions sent to ${windowName}`);
    return;
  }

  // Check if this is a simple option selection
  if (isOptionSelection(text)) {
    const key = getOptionKey(text);
    if (key) {
      console.log(`[${new Date().toISOString()}] Sending option key: ${key}`);
      execSync(`tmux send-keys -t ${TMUX_SESSION}:${windowName} '${key}'`);
      return;
    }
  }

  const escaped = text.replace(/'/g, "'\\''");
  console.log(`[${new Date().toISOString()}] Sending to ${windowName}: "${text.substring(0, 50)}..."`);
  execSync(`tmux send-keys -t ${TMUX_SESSION}:${windowName} -l '${escaped}'`);
  execSync(`tmux send-keys -t ${TMUX_SESSION}:${windowName} Enter`);
  // Wait and send second Enter for paste mode handling
  await new Promise(resolve => setTimeout(resolve, TIMING.ENTER_KEY_DELAY));
  try {
    execSync(`tmux send-keys -t ${TMUX_SESSION}:${windowName} Enter`);
    console.log(`[${new Date().toISOString()}] Message sent successfully to ${windowName}`);
  } catch (e) {
    console.log(`[${new Date().toISOString()}] Error sending second Enter: ${e.message}`);
  }
}

// Check if text is an option selection (single digit, "yes", "no", "y", "n")
function isOptionSelection(text) {
  const normalized = text.trim().toLowerCase();
  return /^[1-9]$/.test(normalized) ||
         ['yes', 'no', 'y', 'n'].includes(normalized);
}

// Check if text is a rejection option (3, n, no) - Claude won't continue after these
function isRejectionOption(text) {
  const normalized = text.trim().toLowerCase();
  return normalized === '3' || normalized === 'n' || normalized === 'no';
}

// Check if text is an option with additional instructions (e.g., "1 but only this file" or "3 try something else")
// Returns { hasInstructions: boolean, optionKey: string, instructions: string }
function parseOptionWithInstructions(text) {
  const normalized = text.trim();

  // Match "<digit> <instructions>" or "<digit>. <instructions>"
  const digitMatch = normalized.match(/^([1-9])\.?\s+(.+)$/s);
  if (digitMatch) {
    return { hasInstructions: true, optionKey: digitMatch[1], instructions: digitMatch[2].trim() };
  }

  // Match "yes <instructions>" or "y <instructions>"
  const yesMatch = normalized.match(/^(yes|y)\s+(.+)$/is);
  if (yesMatch) {
    return { hasInstructions: true, optionKey: '1', instructions: yesMatch[2].trim() };
  }

  // Match "no <instructions>" or "n <instructions>"
  const noMatch = normalized.match(/^(no|n)\s+(.+)$/is);
  if (noMatch) {
    return { hasInstructions: true, optionKey: '3', instructions: noMatch[2].trim() };
  }

  return { hasInstructions: false, optionKey: null, instructions: null };
}

// Get the key to send for an option selection
function getOptionKey(text) {
  const normalized = text.trim().toLowerCase();
  if (/^[1-9]$/.test(normalized)) {
    return normalized; // Send the digit
  }
  if (normalized === 'yes' || normalized === 'y') {
    return '1'; // Option 1 is typically Yes
  }
  if (normalized === 'no' || normalized === 'n') {
    return '3'; // Option 3 is typically No (or last option)
  }
  return null;
}

// ============================================
// Slack Helpers
// ============================================

// Add emoji reaction to a Slack message
async function addReaction(channel, timestamp, emoji) {
  try {
    await app.client.reactions.add({
      channel: channel,
      name: emoji,
      timestamp: timestamp
    });
  } catch (e) {
    // Ignore reaction errors (may already exist)
  }
}

// Notify user that session has ended (if enabled)
async function notifySessionEnded(channel, threadTs) {
  if (!config.multiSession.notifyOnTimeout) return;

  try {
    await app.client.chat.postMessage({
      channel: channel,
      thread_ts: threadTs,
      text: '⏱️ Session timed out due to inactivity. Send a message to restart.'
    });
  } catch (e) {
    console.error(`Failed to notify session end: ${e.message}`);
  }
}

// ============================================
// File Download Helpers
// ============================================

// Supported file types that Claude can read
const SUPPORTED_IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
const SUPPORTED_DOC_TYPES = ['pdf'];
const SUPPORTED_TEXT_TYPES = [
  'txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java',
  'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'html', 'css', 'scss', 'sass', 'less',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'sh', 'bash', 'zsh',
  'sql', 'graphql', 'vue', 'svelte', 'astro', 'swift', 'kt', 'scala', 'clj',
  'ex', 'exs', 'erl', 'hs', 'ml', 'fs', 'r', 'jl', 'lua', 'pl', 'pm', 'rake',
  'gemspec', 'podspec', 'gradle', 'cmake', 'makefile', 'dockerfile', 'env',
  'gitignore', 'editorconfig', 'prettierrc', 'eslintrc', 'babelrc'
];

// Check if file type is supported by Claude
function isFileSupported(filename) {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const basename = filename.toLowerCase();

  // Check known extensions
  if (SUPPORTED_IMAGE_TYPES.includes(ext)) return { supported: true, type: 'image' };
  if (SUPPORTED_DOC_TYPES.includes(ext)) return { supported: true, type: 'document' };
  if (SUPPORTED_TEXT_TYPES.includes(ext)) return { supported: true, type: 'text' };

  // Check common filenames without extensions
  const knownFiles = ['makefile', 'dockerfile', 'gemfile', 'rakefile', 'procfile'];
  if (knownFiles.includes(basename)) return { supported: true, type: 'text' };

  return { supported: false, type: 'unknown' };
}

// Download a file from Slack to local temp directory
async function downloadSlackFile(file, threadTs) {
  const tempDir = `/tmp/claude-slack-files/${threadTs}`;
  mkdirSync(tempDir, { recursive: true });

  // Generate unique filename
  let filename = file.name || `file-${Date.now()}`;
  let filepath = `${tempDir}/${filename}`;

  // Handle duplicate names
  let counter = 1;
  while (existsSync(filepath)) {
    const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
    const base = filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename;
    filepath = `${tempDir}/${base}-${counter}${ext}`;
    counter++;
  }

  // Download with auth
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMING.FILE_DOWNLOAD_TIMEOUT);

  let response;
  try {
    response = await fetch(file.url_private_download, {
      headers: { 'Authorization': `Bearer ${config.botToken}` },
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timeout);
    console.error(`Failed to download ${file.name}: ${e.message}`);
    return null;
  }
  clearTimeout(timeout);

  if (!response.ok) {
    console.error(`Failed to download ${file.name}: ${response.status}`);
    return null;
  }

  // Stream to file
  const fileStream = createWriteStream(filepath);
  await pipeline(response.body, fileStream);

  console.log(`Downloaded: ${file.name} -> ${filepath}`);
  return filepath;
}

// ============================================
// Session Lifecycle
// ============================================

async function createSession(threadTs, channel, workingDir) {
  // Use temporary window name until Claude reports its session_id
  const tempWindowName = `new-${windowIndex++}`;

  // Create new tmux window (in background)
  execSync(`tmux new-window -d -t ${TMUX_SESSION}: -n ${tempWindowName}`);

  // Small delay to ensure window is fully created
  await new Promise(resolve => setTimeout(resolve, TIMING.WINDOW_CREATE_DELAY));

  // Change to working directory first (use double quotes for paths with spaces)
  if (workingDir) {
    execSync(`tmux send-keys -t ${TMUX_SESSION}:${tempWindowName} 'cd "${workingDir}"' Enter`);
  }

  // Start Claude in the window with environment variables (for tool isolation)
  const env = `CLAUDE_THREAD_TS=${threadTs} CLAUDE_SLACK_CHANNEL=${channel}`;
  execSync(`tmux send-keys -t ${TMUX_SESSION}:${tempWindowName} '${env} claude' Enter`);

  // Auto-confirm trust prompt after Claude starts (user specified this directory)
  setTimeout(() => {
    try {
      execSync(`tmux send-keys -t ${TMUX_SESSION}:${tempWindowName} '1'`);
    } catch (e) {
      // Window may have closed or Claude not ready yet
    }
  }, TIMING.TRUST_PROMPT_DELAY);

  return {
    window: tempWindowName,  // Will be updated to 8-char session_id by hook
    sessionId: null,         // Will be set to full UUID by hook on first response
    channel: channel,
    workingDir: workingDir || process.env.HOME,
    created_at: new Date().toISOString(),
    last_activity: new Date().toISOString(),
    idle_since: null,
    status: 'starting'
  };
}

async function resurrectSession(threadTs, channel, fullSessionId, workingDir) {
  const tempWindowName = `new-${windowIndex++}`;

  // Create new tmux window (in background)
  execSync(`tmux new-window -d -t ${TMUX_SESSION}: -n ${tempWindowName}`);

  // Small delay to ensure window is fully created
  await new Promise(resolve => setTimeout(resolve, TIMING.WINDOW_CREATE_DELAY));

  // Change to working directory (use stored dir from original session)
  const sessions = loadSessions();
  const effectiveDir = workingDir || sessions[threadTs]?.workingDir || process.env.HOME;
  execSync(`tmux send-keys -t ${TMUX_SESSION}:${tempWindowName} 'cd "${effectiveDir}"' Enter`);

  // Resume previous Claude session using full UUID
  const env = `CLAUDE_THREAD_TS=${threadTs} CLAUDE_SLACK_CHANNEL=${channel}`;
  execSync(`tmux send-keys -t ${TMUX_SESSION}:${tempWindowName} '${env} claude --resume ${fullSessionId}' Enter`);

  // Auto-confirm trust prompt if shown
  setTimeout(() => {
    try {
      execSync(`tmux send-keys -t ${TMUX_SESSION}:${tempWindowName} '1'`);
    } catch (e) {
      // Window may have closed or Claude not ready yet
    }
  }, TIMING.TRUST_PROMPT_DELAY);

  return {
    window: tempWindowName,  // Will be renamed to 8-char session_id by hook
    sessionId: fullSessionId, // Keep the same full UUID
    channel: channel,
    workingDir: effectiveDir,
    created_at: new Date().toISOString(),
    last_activity: new Date().toISOString(),
    idle_since: null,
    status: 'starting'
  };
}

function terminateSession(threadTs, session) {
  // Kill the tmux window
  try {
    execSync(`tmux kill-window -t ${TMUX_SESSION}:${session.window}`);
  } catch (e) {
    // Window may already be gone
  }

  // Note: temp files are NOT deleted here to allow session resurrection
  // Old temp files are cleaned up by startTempFileCleanupInterval()

  // Update session status
  const sessions = loadSessions();
  if (sessions[threadTs]) {
    sessions[threadTs].status = 'terminated';
    saveSessions(sessions);
  }

  // Notify in Slack thread
  notifySessionEnded(session.channel, threadTs);

  console.log(`[${new Date().toISOString()}] Session ${session.window} terminated (thread: ${threadTs})`);
}

// ============================================
// Idle Timeout Cleanup
// ============================================

function startCleanupInterval() {
  setInterval(() => {
    const sessions = loadSessions();
    const now = new Date();
    const timeoutMs = config.multiSession.idleTimeoutMinutes * 60 * 1000;

    for (const [threadTs, session] of Object.entries(sessions)) {
      if (session.status === 'idle' && session.idle_since) {
        const idleTime = now - new Date(session.idle_since);

        if (idleTime > timeoutMs) {
          console.log(`[${new Date().toISOString()}] Session ${session.window} idle for ${Math.round(idleTime/1000)}s, terminating...`);
          terminateSession(threadTs, session);
        }
      }
    }
  }, TIMING.IDLE_CHECK_INTERVAL);
}

// ============================================
// Crash Detection (Health Check)
// ============================================

async function notifySessionCrashed(channel, threadTs) {
  try {
    await app.client.chat.postMessage({
      channel: channel,
      thread_ts: threadTs,
      text: ':warning: Session ended unexpectedly. Send a message to restart.'
    });
  } catch (e) {
    console.error(`Failed to notify session crash: ${e.message}`);
  }
}

function startHealthCheckInterval() {
  setInterval(() => {
    const sessions = loadSessions();
    let changed = false;

    for (const [threadTs, session] of Object.entries(sessions)) {
      // Only check non-terminated sessions
      if (session.status === 'terminated') continue;

      // Check if tmux window still exists
      if (!tmuxWindowExists(session.window)) {
        console.log(`[${new Date().toISOString()}] Session ${session.window} crashed (window disappeared)`);
        sessions[threadTs].status = 'terminated';
        changed = true;

        // Notify user
        notifySessionCrashed(session.channel, threadTs);
      }
    }

    if (changed) {
      saveSessions(sessions);
    }
  }, TIMING.HEALTH_CHECK_INTERVAL);
}

// ============================================
// Temp File Cleanup
// ============================================

const TEMP_FILES_DIR = '/tmp/claude-slack-files';

function startTempFileCleanupInterval() {
  // Run cleanup once at startup
  cleanupOldTempFiles();

  // Then run periodically
  setInterval(cleanupOldTempFiles, TIMING.TEMP_CLEANUP_INTERVAL);
}

function cleanupOldTempFiles() {
  if (!existsSync(TEMP_FILES_DIR)) return;

  const retentionDays = config.multiSession.tempFileRetentionDays;
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let cleanedCount = 0;

  try {
    const dirs = readdirSync(TEMP_FILES_DIR);

    for (const dir of dirs) {
      const dirPath = `${TEMP_FILES_DIR}/${dir}`;

      try {
        const stat = statSync(dirPath);
        if (!stat.isDirectory()) continue;

        const age = now - stat.mtimeMs;

        if (age > maxAgeMs) {
          rmSync(dirPath, { recursive: true, force: true });
          cleanedCount++;
          console.log(`[${new Date().toISOString()}] Cleaned up old temp dir: ${dir} (age: ${Math.round(age / 86400000)} days)`);
        }
      } catch (e) {
        // Ignore individual directory errors
      }
    }

    if (cleanedCount > 0) {
      console.log(`[${new Date().toISOString()}] Temp file cleanup: removed ${cleanedCount} directories older than ${retentionDays} days`);
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Temp file cleanup error: ${e.message}`);
  }
}

// ============================================
// Startup Reconnection
// ============================================

async function reconnectSessions() {
  const sessions = loadSessions();
  let changed = false;

  for (const [threadTs, session] of Object.entries(sessions)) {
    if (session.status === 'terminated') continue;

    // Check if tmux window still exists
    if (tmuxWindowExists(session.window)) {
      console.log(`✓ Session ${session.window} still active`);
    } else {
      // Window gone - mark as terminated (can be resurrected via --resume)
      console.log(`✗ Session ${session.window} no longer exists, marking terminated`);
      sessions[threadTs].status = 'terminated';
      changed = true;
    }
  }

  if (changed) {
    saveSessions(sessions);
  }
}

// ============================================
// Message Handling
// ============================================

async function handleMessage(message, channel, say) {
  const threadTs = message.thread_ts || message.ts;
  const isNewThread = !message.thread_ts;  // First message creates thread

  // Guard against empty messages (but allow messages with only files)
  if (!message.text && (!message.files || message.files.length === 0)) {
    console.log(`[${new Date().toISOString()}] Ignoring empty message in thread ${threadTs}`);
    return;
  }

  // Parse working directory from message (only for new threads)
  let messageText = message.text || '';
  let workingDir = null;
  let dirWarning = null;

  if (isNewThread && messageText) {
    const { requestedPath, message: cleanMessage } = parseWorkingDir(messageText);
    messageText = cleanMessage;
    const resolved = resolveWorkingDir(requestedPath);
    workingDir = resolved.path;
    dirWarning = resolved.warning;
  }

  // Load sessions
  let sessions = loadSessions();

  // Check if session exists for this thread
  let session = sessions[threadTs];

  if (!session || session.status === 'terminated') {
    // Use lock to prevent race condition on simultaneous messages
    const created = await withSessionLock(threadTs, async () => {
      // Re-load sessions inside lock (another call may have created it)
      sessions = loadSessions();
      session = sessions[threadTs];

      // Double-check: session may have been created while we waited for lock
      if (session && session.status !== 'terminated') {
        return null;  // Already exists, skip creation
      }

      // Check concurrent session limit
      const activeCount = Object.values(sessions)
        .filter(s => s.status !== 'terminated').length;

      if (activeCount >= config.multiSession.maxConcurrent) {
        await say({ text: `⚠️ Maximum concurrent sessions (${config.multiSession.maxConcurrent}) reached. Please wait for an existing conversation to complete.`, thread_ts: threadTs });
        return 'limit_reached';
      }

      // Check if we should resurrect (terminated session with full sessionId)
      if (session?.status === 'terminated' && session.sessionId && !session.window.startsWith('new-')) {
        // Resurrect session using claude --resume
        console.log(`[${new Date().toISOString()}] Resurrecting session ${session.sessionId} for thread ${threadTs}`);
        session = await resurrectSession(threadTs, channel, session.sessionId, workingDir);
      } else {
        // Create new session
        console.log(`[${new Date().toISOString()}] Creating new session for thread ${threadTs}`);
        session = await createSession(threadTs, channel, workingDir);
      }

      sessions[threadTs] = session;
      saveSessions(sessions);
      return session;
    });

    // Handle lock results
    if (created === 'limit_reached') return;
    if (created === null) {
      // Session was created by concurrent call, reload
      sessions = loadSessions();
      session = sessions[threadTs];
    }

    // Post warning if working directory was invalid
    if (dirWarning) {
      await say({ text: dirWarning, thread_ts: threadTs });
    }
  }

  // Check if session was just created (need to wait for trust prompt)
  const isNewSession = session.status === 'starting';

  // Update activity timestamp (save deferred until after message processing)
  session.last_activity = new Date().toISOString();
  session.idle_since = null;
  session.status = session.status === 'starting' ? 'starting' : 'active';
  sessions[threadTs] = session;

  // Handle file attachments
  let filePaths = [];
  let unsupportedFiles = [];

  if (message.files && message.files.length > 0) {
    console.log(`[${new Date().toISOString()}] Processing ${message.files.length} file(s)`);

    for (const file of message.files) {
      const fileInfo = isFileSupported(file.name || '');

      if (fileInfo.supported) {
        const localPath = await downloadSlackFile(file, threadTs);
        if (localPath) {
          filePaths.push(localPath);
        }
      } else {
        unsupportedFiles.push(file.name || 'unknown');
        console.log(`[${new Date().toISOString()}] Skipping unsupported file type: ${file.name}`);
      }
    }
  }

  // Note unsupported files in message
  if (unsupportedFiles.length > 0) {
    messageText += '\n\n[Unsupported file types: ' + unsupportedFiles.join(', ') + ']';
  }

  // Send message to appropriate tmux window
  console.log(`[${new Date().toISOString()}] Routing message to window ${session.window}`);

  if (isNewSession) {
    // Wait for Claude to start and show prompt
    console.log(`[${new Date().toISOString()}] New session - waiting for Claude to be ready...`);
    await waitForClaudeReady(session.window);
  }

  // Send files first if any, then send text
  if (filePaths.length > 0) {
    // Send each file path and wait for paste mode to complete
    for (const filepath of filePaths) {
      console.log(`[${new Date().toISOString()}] Sending file: ${filepath}`);
      // Write pending file so hook knows this came from Slack (trim for consistent hash)
      const fileHash = createHash('md5').update(filepath.trim()).digest('hex');
      writeFileSync(`/tmp/claude-slack-pending-${threadTs}`, fileHash);
      await sendToWindow(session.window, filepath);
      // Wait for Claude to process the image paste
      await new Promise(resolve => setTimeout(resolve, TIMING.FILE_PASTE_DELAY));
    }
  }

  // Add eyes reaction to show message was received
  await addReaction(channel, message.ts, 'eyes');
  sessions[threadTs].lastMessageTs = message.ts;
  console.log(`[${new Date().toISOString()}] Stored lastMessageTs: ${message.ts} for thread ${threadTs}`);
  saveSessions(sessions);

  // Send the text message
  if (messageText.trim()) {
    let textToSend = messageText;

    // If there's a pending permission and the message is not an option selection,
    // treat it as rejection with instructions (implicit "3 <message>")
    if (session.pendingPermission && !isOptionSelection(messageText) && !parseOptionWithInstructions(messageText).hasInstructions) {
      console.log(`[${new Date().toISOString()}] Pending permission + arbitrary text -> treating as rejection with instructions`);
      textToSend = `3 ${messageText}`;
    }

    // Clear pendingPermission flag since we're responding
    if (session.pendingPermission) {
      session.pendingPermission = false;
      saveSessions(sessions);
    }

    console.log(`[${new Date().toISOString()}] Sending text: ${textToSend.substring(0, 50)}...`);
    // Write pending file so hook knows this message came from Slack (trim for consistent hash)
    const msgHash = createHash('md5').update(messageText.trim()).digest('hex');
    writeFileSync(`/tmp/claude-slack-pending-${threadTs}`, msgHash);
    await sendToWindow(session.window, textToSend);

    // For rejection options (3, n, no), remove eyes after a brief delay since Claude won't continue
    // For acceptance options (1, 2, y, yes), let hooks remove eyes when Claude finishes
    if (isRejectionOption(messageText)) {
      setTimeout(async () => {
        try {
          await app.client.reactions.remove({
            channel: channel,
            name: 'eyes',
            timestamp: message.ts
          });
          console.log(`[${new Date().toISOString()}] Removed eyes from rejection option`);
        } catch (e) {
          // Ignore - reaction might already be removed by hook
        }
      }, 1500);  // 1.5s delay so user sees eyes briefly
    }
  }
}

// ============================================
// Shared Command Formatters
// ============================================

// Check if user is authorized
function isAuthorized(userId) {
  if (!config.allowedUsers || config.allowedUsers.length === 0) {
    return true;
  }
  return config.allowedUsers.includes(userId);
}

// Format a single session for display
function formatSession(threadTs, s) {
  const now = new Date();
  const idleTime = s.idle_since ? Math.round((now - new Date(s.idle_since)) / 1000) : 0;
  const statusEmoji = s.status === 'idle' ? ':zzz:' : s.status === 'starting' ? ':hourglass:' : ':green_circle:';
  const idleStr = s.status === 'idle' ? ` (idle ${idleTime}s)` : '';
  const dir = s.workingDir?.replace(process.env.HOME, '~') || '~';
  const threadLink = workspaceUrl && s.channel
    ? `<${workspaceUrl}archives/${s.channel}/p${threadTs.replace('.', '')}|→>`
    : '';
  return { statusEmoji, dir, idleStr, threadLink, window: s.window };
}

// Get bridge status info
function getBridgeStatus() {
  const sessions = loadSessions();
  return {
    active: Object.values(sessions).filter(s => s.status !== 'terminated').length,
    idle: Object.values(sessions).filter(s => s.status === 'idle').length,
    terminated: Object.values(sessions).filter(s => s.status === 'terminated').length,
    tmuxOk: tmuxSessionExists()
  };
}

// Format status message
function formatStatusMessage(status) {
  const tmuxEmoji = status.tmuxOk ? ':white_check_mark:' : ':x:';
  return `:robot_face: *Claude Code Bridge Status*\n` +
    `• tmux session \`${TMUX_SESSION}\`: ${tmuxEmoji}\n` +
    `• Active sessions: ${status.active}/${config.multiSession.maxConcurrent}\n` +
    `• Idle sessions: ${status.idle}\n` +
    `• Terminated (can resurrect): ${status.terminated}\n` +
    `• Idle timeout: ${config.multiSession.idleTimeoutMinutes} minutes`;
}

// Format help message
function formatHelpMessage() {
  return `:information_source: *Bot Commands*\n` +
    `• \`!sessions\` or \`!s\` - List active sessions\n` +
    `• \`!status\` - Show bridge status\n` +
    `• \`!find <name>\` or \`!f\` - Find project directories\n` +
    `• \`!kill <window>\` - Terminate a session by window name\n` +
    `• \`!kill\` (in thread) - Terminate current session\n` +
    `• \`!status\` (in thread) - Show current session info\n` +
    `• \`!help\` - Show this help\n\n` +
    `*Reactions:* :octagonal_sign: kill, :white_check_mark: approve, :x: reject\n\n` +
    `To start a Claude session, just send a message (creates new thread).\n` +
    `Use \`[/path]\` prefix to set a custom working directory.`;
}

// Kill a session by window name, returns result message
function killSession(windowName) {
  if (!windowName) {
    return { success: false, message: ':warning: Usage: `!kill <window-name>`\nUse `!sessions` to see active windows.' };
  }

  const sessions = loadSessions();
  const entry = Object.entries(sessions).find(([_, s]) => s.window === windowName && s.status !== 'terminated');

  if (!entry) {
    return { success: false, message: `:warning: Session \`${windowName}\` not found or already terminated.` };
  }

  const [threadTs, session] = entry;
  terminateSession(threadTs, session);
  return { success: true, message: `:skull: Session \`${windowName}\` terminated.` };
}

// Get git branch for a directory (returns null if not a git repo)
function getGitBranch(dir) {
  try {
    const fullPath = dir.replace(/^~/, process.env.HOME);
    const branch = execSync(`git -C "${fullPath}" rev-parse --abbrev-ref HEAD 2>/dev/null`, { encoding: 'utf-8' }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

// Find directories matching query
function findDirectories(query) {
  if (!query) {
    return { success: false, paths: [], message: ':warning: Usage: `!find <name>` - Search for project directories' };
  }

  // Sanitize query to prevent command injection
  const safeQuery = query.replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!safeQuery) {
    return { success: false, paths: [], message: ':warning: Invalid search query' };
  }

  try {
    const result = execSync(
      `find ~ -maxdepth 4 -type d -iname "*${safeQuery}*" 2>/dev/null | head -20`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();

    if (!result) {
      return { success: true, paths: [], message: `:mag: No directories found matching \`${query}\`` };
    }

    const paths = result.split('\n')
      .map(p => {
        const displayPath = p.replace(process.env.HOME, '~');
        const branch = getGitBranch(displayPath);
        return { path: displayPath, branch };
      })
      .slice(0, 10);

    return { success: true, paths, message: `:mag: Found ${paths.length} matching "${query}":` };
  } catch (err) {
    return { success: false, paths: [], message: `:warning: Search failed: ${err.message}` };
  }
}

// ============================================
// Bot Commands (via DM)
// ============================================

async function handleBotCommand(text, channel, say) {
  const cmd = text.toLowerCase();

  // !sessions - List active sessions
  if (cmd === '!sessions' || cmd === '!s') {
    const sessions = loadSessions();
    const activeSessions = Object.entries(sessions).filter(([_, s]) => s.status !== 'terminated');

    if (activeSessions.length === 0) {
      await say(':information_source: No active sessions.');
      return true;
    }

    await say(`:clipboard: *Active Sessions (${activeSessions.length}/${config.multiSession.maxConcurrent})*`);

    for (const [threadTs, s] of activeSessions) {
      const fmt = formatSession(threadTs, s);
      await say(`${fmt.statusEmoji} ${fmt.dir}${fmt.idleStr} ${fmt.threadLink}`);
      await say(fmt.window);
    }
    return true;
  }

  // !status - Show bridge status
  if (cmd === '!status') {
    await say(formatStatusMessage(getBridgeStatus()));
    return true;
  }

  // !kill <window> - Terminate a session
  if (cmd.startsWith('!kill ')) {
    const windowName = text.slice(6).trim();
    const result = killSession(windowName);
    await say(result.message);
    return true;
  }

  // !find <query> - Find project paths
  if (cmd.startsWith('!find ') || cmd.startsWith('!f ')) {
    const query = text.slice(cmd.startsWith('!f ') ? 3 : 6).trim();
    const result = findDirectories(query);

    await say(result.message);
    if (result.success && result.paths.length > 0) {
      for (const p of result.paths) {
        await say(p.path);
        if (p.branch) {
          await say(`:branch: ${p.branch}`);
        }
      }
    }
    return true;
  }

  // !help - Show available commands
  if (cmd === '!help' || cmd === '!h') {
    await say(formatHelpMessage());
    return true;
  }

  return false; // Not a recognized command
}

// ============================================
// Slack Event Handlers
// ============================================

// Handle direct messages to the bot
app.message(async ({ message, say }) => {

  // Ignore bot messages and most message subtypes (edits, deletes, etc.)
  // But allow file_share subtype for file attachments
  if (message.bot_id) return;
  if (message.subtype && message.subtype !== 'file_share') return;
  if (!message.user) return;

  // Check if user is allowed (optional security)
  if (!isAuthorized(message.user)) {
    await say("Sorry, you're not authorized to control Claude Code.");
    return;
  }

  const isThread = !!message.thread_ts;
  const threadTs = message.thread_ts || message.ts;
  const text = message.text?.trim() || '';
  console.log(`[${new Date().toISOString()}] Message from ${message.user}${isThread ? ' (in thread)' : ''}: ${text.substring(0, 100) || '(empty)'}`);

  // Check if this thread is a Claude session
  const sessions = loadSessions();
  const isClaudeSession = isThread && sessions[message.thread_ts];

  // Special case: !kill within a Claude session kills that session
  if (text.toLowerCase() === '!kill' && isClaudeSession) {
    const session = sessions[message.thread_ts];
    if (session && session.status !== 'terminated') {
      terminateSession(message.thread_ts, session);
      await say({ text: ':skull: Session terminated.', thread_ts: message.thread_ts });
    } else {
      await say({ text: ':information_source: Session already terminated.', thread_ts: message.thread_ts });
    }
    return;
  }

  // Special case: !status within a Claude session shows session info
  if (text.toLowerCase() === '!status' && isClaudeSession) {
    const session = sessions[message.thread_ts];
    if (session) {
      const now = new Date();
      const lastActivity = session.last_activity ? new Date(session.last_activity) : null;
      const idleSeconds = lastActivity ? Math.round((now - lastActivity) / 1000) : 0;
      const idleStr = idleSeconds > 60 ? `${Math.round(idleSeconds / 60)}m` : `${idleSeconds}s`;
      const dir = session.workingDir?.replace(process.env.HOME, '~') || '~';
      const statusEmoji = session.status === 'idle' ? ':zzz:' : session.status === 'starting' ? ':hourglass:' : ':green_circle:';

      await say({
        text: `${statusEmoji} *Session Info*\n` +
          `• Window: \`${session.window}\`\n` +
          `• Directory: \`${dir}\`\n` +
          `• Status: ${session.status}\n` +
          `• Idle: ${idleStr}\n` +
          `• Session ID: \`${session.sessionId || 'pending'}\``,
        thread_ts: message.thread_ts
      });
    } else {
      await say({ text: ':warning: Session not found.', thread_ts: message.thread_ts });
    }
    return;
  }

  // Handle bot commands:
  // - In main conversation: always handle, respond in new thread
  // - In thread: only handle if NOT a Claude session (i.e., command thread)
  if (text.startsWith('!') && !isClaudeSession) {
    // Wrap say to reply in thread
    const sayInThread = (text) => say({ text, thread_ts: isThread ? message.thread_ts : message.ts });
    try {
      const handled = await handleBotCommand(text, message.channel, sayInThread);
      if (handled) return;
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Command error:`, err);
      await sayInThread(`:warning: Command failed: ${err.message}`);
      return;
    }
  }

  await handleMessage(message, message.channel, say);
});

// Handle app mentions in channels
app.event('app_mention', async ({ event, say }) => {
  // Check if user is allowed
  if (!isAuthorized(event.user)) {
    await say("Sorry, you're not authorized to control Claude Code.");
    return;
  }

  // Remove the bot mention from the text
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!text) {
    await say("Send me a message and I'll forward it to Claude Code!");
    return;
  }

  const isThread = !!event.thread_ts;
  console.log(`[${new Date().toISOString()}] Mention from ${event.user}${isThread ? ' (in thread)' : ''}: ${text.substring(0, 100)}`);

  // Create message-like object for handleMessage
  const messageObj = {
    text: text,
    ts: event.ts,
    thread_ts: event.thread_ts,
    user: event.user
  };

  await handleMessage(messageObj, event.channel, say);
});

// Handle reactions as commands
app.event('reaction_added', async ({ event }) => {
  // Only handle reactions from authorized users
  if (!isAuthorized(event.user)) return;

  // Only handle reactions in threads (Claude sessions)
  if (!event.item.ts) return;

  const sessions = loadSessions();
  // Find session by thread_ts (the reaction could be on any message in the thread)
  // We need to find if this message belongs to a Claude session thread
  const threadTs = event.item.ts;

  // Check if there's a session for this thread or if the message is in a session thread
  let session = sessions[threadTs];
  let sessionThreadTs = threadTs;

  // If not found directly, this might be a reaction on a reply in the thread
  // We'd need the thread_ts of the parent, but reaction_added doesn't give us that
  // So we'll only handle reactions on the original message that started the session
  if (!session) {
    // Try to find a session where this ts might be a message in the thread
    // This is limited - reactions only work on the thread's parent message
    return;
  }

  if (session.status === 'terminated') return;

  const reaction = event.reaction;
  console.log(`[${new Date().toISOString()}] Reaction ${reaction} on session ${session.window}`);

  // 🛑 Stop/kill session
  if (reaction === 'octagonal_sign' || reaction === 'stop_sign' || reaction === 'no_entry') {
    console.log(`[${new Date().toISOString()}] Killing session via reaction`);
    terminateSession(sessionThreadTs, session);
    // Post confirmation
    try {
      await app.client.chat.postMessage({
        channel: event.item.channel,
        thread_ts: sessionThreadTs,
        text: ':skull: Session terminated via reaction.'
      });
    } catch (e) {
      console.error(`Failed to post termination message: ${e.message}`);
    }
    return;
  }

  // ✅ Approve permission prompt (send "1" to select first option)
  if (reaction === 'white_check_mark' || reaction === 'heavy_check_mark') {
    console.log(`[${new Date().toISOString()}] Approving via reaction`);
    try {
      execSync(`tmux send-keys -t ${TMUX_SESSION}:${session.window} '1'`);
    } catch (e) {
      console.error(`Failed to send approval: ${e.message}`);
    }
    return;
  }

  // ❌ Reject/deny permission prompt (send "2" for No or Escape to cancel)
  if (reaction === 'x' || reaction === 'negative_squared_cross_mark') {
    console.log(`[${new Date().toISOString()}] Rejecting via reaction`);
    try {
      execSync(`tmux send-keys -t ${TMUX_SESSION}:${session.window} Escape`);
    } catch (e) {
      console.error(`Failed to send rejection: ${e.message}`);
    }
    return;
  }
});

// ============================================
// Slash Commands (use shared formatters)
// ============================================

// /claude-sessions - List active sessions
app.command('/claude-sessions', async ({ command, ack, respond }) => {
  await ack();

  if (!isAuthorized(command.user_id)) {
    await respond("Sorry, you're not authorized.");
    return;
  }

  const sessions = loadSessions();
  const activeSessions = Object.entries(sessions).filter(([_, s]) => s.status !== 'terminated');

  if (activeSessions.length === 0) {
    await respond(':information_source: No active sessions.');
    return;
  }

  const lines = activeSessions.map(([threadTs, s]) => {
    const fmt = formatSession(threadTs, s);
    return `${fmt.statusEmoji} \`${fmt.window}\` - ${fmt.dir}${fmt.idleStr} ${fmt.threadLink}`;
  });

  await respond(`:clipboard: *Active Sessions (${activeSessions.length}/${config.multiSession.maxConcurrent})*\n${lines.join('\n')}`);
});

// /claude-status - Show bridge status
app.command('/claude-status', async ({ command, ack, respond }) => {
  await ack();

  if (!isAuthorized(command.user_id)) {
    await respond("Sorry, you're not authorized.");
    return;
  }

  await respond(formatStatusMessage(getBridgeStatus()));
});

// /claude-kill - Terminate a session
app.command('/claude-kill', async ({ command, ack, respond }) => {
  await ack();

  if (!isAuthorized(command.user_id)) {
    await respond("Sorry, you're not authorized.");
    return;
  }

  const result = killSession(command.text.trim());
  await respond(result.message);
});

// /claude-find - Find project directories
app.command('/claude-find', async ({ command, ack, respond }) => {
  await ack();

  if (!isAuthorized(command.user_id)) {
    await respond("Sorry, you're not authorized.");
    return;
  }

  const result = findDirectories(command.text.trim());
  if (result.paths.length > 0) {
    const lines = result.paths.map(p => {
      let line = p.path;
      if (p.branch) {
        line += `\n:branch: ${p.branch}`;
      }
      return line;
    });
    await respond(`${result.message}\n${lines.join('\n')}`);
  } else {
    await respond(result.message);
  }
});

// /claude-help - Show help
app.command('/claude-help', async ({ command, ack, respond }) => {
  await ack();
  await respond(formatHelpMessage());
});

// ============================================
// Startup
// ============================================

(async () => {
  // Reconnect to existing sessions
  await reconnectSessions();

  // Start idle cleanup interval
  startCleanupInterval();

  // Start crash detection health check
  startHealthCheckInterval();

  // Start temp file cleanup (removes files older than 2 weeks)
  startTempFileCleanupInterval();

  // Start the Slack app
  await app.start();

  // Fetch workspace URL for thread links
  try {
    const authResult = await app.client.auth.test();
    workspaceUrl = authResult.url; // e.g., https://workspace.slack.com/
  } catch (e) {
    console.warn('Could not fetch workspace URL:', e.message);
  }

  console.log('');
  console.log('===========================================');
  console.log('  Claude Code Slack Bridge (Multi-Session)');
  console.log('===========================================');
  console.log('');
  console.log(`tmux session: ${TMUX_SESSION}`);
  console.log(`Max concurrent sessions: ${config.multiSession.maxConcurrent}`);
  console.log(`Idle timeout: ${config.multiSession.idleTimeoutMinutes} minutes`);
  console.log(`Default working dir: ${config.multiSession.defaultWorkingDir}`);
  console.log('');
  console.log('Usage:');
  console.log('  - DM the bot or @mention it to start a new session');
  console.log('  - Each thread gets its own Claude instance');
  console.log('  - Use [/path] prefix on new session to set working directory');
  console.log('');

  if (!tmuxSessionExists()) {
    console.warn(`⚠️  Warning: tmux session '${TMUX_SESSION}' not found!`);
    console.warn(`   Start it with: tmux new -s ${TMUX_SESSION}`);
  } else {
    console.log(`✓ tmux session '${TMUX_SESSION}' found`);

    // List active sessions
    const sessions = loadSessions();
    const activeSessions = Object.entries(sessions).filter(([_, s]) => s.status !== 'terminated');
    if (activeSessions.length > 0) {
      console.log(`✓ ${activeSessions.length} active session(s) reconnected`);
    }
  }
})();
