import Bolt from '@slack/bolt';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';

const { App } = Bolt;

// Configuration
const CONFIG_DIR = process.env.HOME + '/.claude/slack-bridge';
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
  config.multiSession.idleTimeoutMinutes = config.multiSession.idleTimeoutMinutes || 15;
  config.multiSession.tmuxSession = config.multiSession.tmuxSession || 'claude';
  config.multiSession.defaultWorkingDir = config.multiSession.defaultWorkingDir || '~';

  return config;
}

const config = loadConfig();
const TMUX_SESSION = config.multiSession.tmuxSession;

// Initialize Slack app with Socket Mode
const app = new App({
  token: config.botToken,
  appToken: config.appToken,
  socketMode: true,
});

// ============================================
// Session Management
// ============================================

// Track window index for temporary names (start at 1 since window 0 is bridge)
let windowIndex = 1;

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

// Check if tmux window exists
function tmuxWindowExists(windowName) {
  try {
    execSync(`tmux select-window -t ${TMUX_SESSION}:${windowName}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Send text to a tmux window
function sendToWindow(windowName, text) {
  // Check if this is an option selection
  if (isOptionSelection(text)) {
    const key = getOptionKey(text);
    if (key) {
      console.log(`[${new Date().toISOString()}] Sending option key: ${key}`);
      execSync(`tmux send-keys -t ${TMUX_SESSION}:${windowName} '${key}'`);
      return;
    }
  }

  const escaped = text.replace(/'/g, "'\\''");
  execSync(`tmux send-keys -t ${TMUX_SESSION}:${windowName} -l '${escaped}'`);
  execSync(`tmux send-keys -t ${TMUX_SESSION}:${windowName} Enter`);
  // Send second Enter for paste mode handling
  setTimeout(() => {
    try {
      execSync(`tmux send-keys -t ${TMUX_SESSION}:${windowName} Enter`);
    } catch (e) {
      // Window may have closed
    }
  }, 100);
}

// Check if text is an option selection (single digit, "yes", "no", "y", "n")
function isOptionSelection(text) {
  const normalized = text.trim().toLowerCase();
  return /^[1-9]$/.test(normalized) ||
         ['yes', 'no', 'y', 'n'].includes(normalized);
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

// Notify user that session has ended
async function notifySessionEnded(channel, threadTs) {
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
// Session Lifecycle
// ============================================

async function createSession(threadTs, channel, workingDir) {
  // Use temporary window name until Claude reports its session_id
  const tempWindowName = `new-${windowIndex++}`;

  // Create new tmux window
  execSync(`tmux new-window -t ${TMUX_SESSION} -n ${tempWindowName}`);

  // Change to working directory first (use double quotes for paths with spaces)
  if (workingDir) {
    execSync(`tmux send-keys -t ${TMUX_SESSION}:${tempWindowName} 'cd "${workingDir}"' Enter`);
  }

  // Start Claude in the window with environment variables (for tool isolation)
  const env = `CLAUDE_THREAD_TS=${threadTs} CLAUDE_SLACK_CHANNEL=${channel}`;
  execSync(`tmux send-keys -t ${TMUX_SESSION}:${tempWindowName} '${env} claude' Enter`);

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

  // Create new tmux window
  execSync(`tmux new-window -t ${TMUX_SESSION} -n ${tempWindowName}`);

  // Change to working directory (use stored dir from original session)
  const sessions = loadSessions();
  const effectiveDir = workingDir || sessions[threadTs]?.workingDir || process.env.HOME;
  execSync(`tmux send-keys -t ${TMUX_SESSION}:${tempWindowName} 'cd "${effectiveDir}"' Enter`);

  // Resume previous Claude session using full UUID
  const env = `CLAUDE_THREAD_TS=${threadTs} CLAUDE_SLACK_CHANNEL=${channel}`;
  execSync(`tmux send-keys -t ${TMUX_SESSION}:${tempWindowName} '${env} claude --resume ${fullSessionId}' Enter`);

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
  }, 60000); // Check every minute
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

  // Guard against empty messages
  if (!message.text) {
    console.log(`[${new Date().toISOString()}] Ignoring empty message in thread ${threadTs}`);
    return;
  }

  // Parse working directory from message (only for new threads)
  let messageText = message.text;
  let workingDir = null;
  let dirWarning = null;

  if (isNewThread) {
    const { requestedPath, message: cleanMessage } = parseWorkingDir(message.text);
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

  // Update activity timestamp
  session.last_activity = new Date().toISOString();
  session.idle_since = null;
  session.status = session.status === 'starting' ? 'starting' : 'active';
  sessions[threadTs] = session;
  saveSessions(sessions);

  // Send message to appropriate tmux window
  console.log(`[${new Date().toISOString()}] Routing message to window ${session.window}: ${messageText.substring(0, 50)}...`);
  sendToWindow(session.window, messageText);

  // Add eyes reaction
  await addReaction(channel, message.ts, 'eyes');
}

// ============================================
// Slack Event Handlers
// ============================================

// Handle direct messages to the bot
app.message(async ({ message, say }) => {
  // Ignore bot messages and message subtypes (edits, deletes, etc.)
  if (message.bot_id) return;
  if (message.subtype) return;
  if (!message.user) return;

  // Check if user is allowed (optional security)
  if (config.allowedUsers && config.allowedUsers.length > 0) {
    if (!config.allowedUsers.includes(message.user)) {
      await say("Sorry, you're not authorized to control Claude Code.");
      return;
    }
  }

  const isThread = !!message.thread_ts;
  console.log(`[${new Date().toISOString()}] Message from ${message.user}${isThread ? ' (in thread)' : ''}: ${message.text?.substring(0, 100) || '(empty)'}`);

  await handleMessage(message, message.channel, say);
});

// Handle app mentions in channels
app.event('app_mention', async ({ event, say }) => {
  // Check if user is allowed
  if (config.allowedUsers && config.allowedUsers.length > 0) {
    if (!config.allowedUsers.includes(event.user)) {
      await say("Sorry, you're not authorized to control Claude Code.");
      return;
    }
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

// Slash command (optional, if you configure one)
app.command('/claude', async ({ command, ack, respond }) => {
  await ack();

  if (config.allowedUsers && config.allowedUsers.length > 0) {
    if (!config.allowedUsers.includes(command.user_id)) {
      await respond("Sorry, you're not authorized to control Claude Code.");
      return;
    }
  }

  const text = command.text;
  console.log(`[${new Date().toISOString()}] Command from ${command.user_id}: ${text}`);

  // For slash commands, we don't have thread context, so just acknowledge
  await respond(`:information_source: Use DM or @mention in a thread to interact with Claude sessions.`);
});

// ============================================
// Startup
// ============================================

(async () => {
  // Reconnect to existing sessions
  await reconnectSessions();

  // Start idle cleanup interval
  startCleanupInterval();

  // Start the Slack app
  await app.start();

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
  console.log('  - Use [/path] prefix to set working directory');
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
