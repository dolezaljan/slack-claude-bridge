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

// Workspace URL for thread links (fetched at startup)
let workspaceUrl = '';

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
async function waitForClaudeReady(windowName, maxWaitMs = 15000) {
  const startTime = Date.now();
  const pollInterval = 300;

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
      // Wait 200ms more for UI to stabilize before sending input
      await new Promise(resolve => setTimeout(resolve, 200));
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  console.log(`[${new Date().toISOString()}] Timeout waiting for Claude in window ${windowName}`);
  return false;
}

// Send text to a tmux window
async function sendToWindow(windowName, text) {
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
  console.log(`[${new Date().toISOString()}] Sending to ${windowName}: "${text.substring(0, 50)}..."`);
  execSync(`tmux send-keys -t ${TMUX_SESSION}:${windowName} -l '${escaped}'`);
  execSync(`tmux send-keys -t ${TMUX_SESSION}:${windowName} Enter`);
  // Wait and send second Enter for paste mode handling
  await new Promise(resolve => setTimeout(resolve, 100));
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

  // Create new tmux window (in background)
  execSync(`tmux new-window -d -t ${TMUX_SESSION}: -n ${tempWindowName}`);

  // Small delay to ensure window is fully created
  await new Promise(resolve => setTimeout(resolve, 100));

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
  }, 2000);

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
  await new Promise(resolve => setTimeout(resolve, 100));

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
  }, 2000);

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
  }, 30000); // Check every 30 seconds
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

  // Check if session was just created (need to wait for trust prompt)
  const isNewSession = session.status === 'starting';

  // Update activity timestamp
  session.last_activity = new Date().toISOString();
  session.idle_since = null;
  session.status = session.status === 'starting' ? 'starting' : 'active';
  sessions[threadTs] = session;
  saveSessions(sessions);

  // Send message to appropriate tmux window
  console.log(`[${new Date().toISOString()}] Routing message to window ${session.window}: ${messageText.substring(0, 50)}...`);

  if (isNewSession) {
    // Wait for Claude to start and show prompt
    console.log(`[${new Date().toISOString()}] New session - waiting for Claude to be ready...`);
    await waitForClaudeReady(session.window);
    // Log what we see before sending
    const paneContent = capturePaneContent(session.window);
    console.log(`[${new Date().toISOString()}] Pane content before send:\n${paneContent.slice(-500)}`);
  }

  await sendToWindow(session.window, messageText);

  // Add eyes reaction and track which message for removal by hook
  await addReaction(channel, message.ts, 'eyes');

  // Store message_ts so hook can remove eyes on Stop
  sessions[threadTs].lastMessageTs = message.ts;
  saveSessions(sessions);
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

    const now = new Date();
    await say(`:clipboard: *Active Sessions (${activeSessions.length}/${config.multiSession.maxConcurrent})*`);

    for (const [threadTs, s] of activeSessions) {
      const idleTime = s.idle_since ? Math.round((now - new Date(s.idle_since)) / 1000) : 0;
      const statusEmoji = s.status === 'idle' ? ':zzz:' : s.status === 'starting' ? ':hourglass:' : ':green_circle:';
      const idleStr = s.status === 'idle' ? ` (idle ${idleTime}s)` : '';
      const dir = s.workingDir?.replace(process.env.HOME, '~') || '~';
      // Build thread link: https://workspace.slack.com/archives/CHANNEL/pTIMESTAMP
      const threadLink = workspaceUrl && s.channel
        ? `<${workspaceUrl}archives/${s.channel}/p${threadTs.replace('.', '')}|→>`
        : '';
      await say(`${statusEmoji} ${dir}${idleStr} ${threadLink}`);
      await say(s.window);
    }
    return true;
  }

  // !status - Show bridge status
  if (cmd === '!status') {
    const sessions = loadSessions();
    const active = Object.values(sessions).filter(s => s.status !== 'terminated').length;
    const idle = Object.values(sessions).filter(s => s.status === 'idle').length;
    const terminated = Object.values(sessions).filter(s => s.status === 'terminated').length;
    const tmuxOk = tmuxSessionExists() ? ':white_check_mark:' : ':x:';

    await say(
      `:robot_face: *Claude Code Bridge Status*\n` +
      `• tmux session \`${TMUX_SESSION}\`: ${tmuxOk}\n` +
      `• Active sessions: ${active}/${config.multiSession.maxConcurrent}\n` +
      `• Idle sessions: ${idle}\n` +
      `• Terminated (can resurrect): ${terminated}\n` +
      `• Idle timeout: ${config.multiSession.idleTimeoutMinutes} minutes`
    );
    return true;
  }

  // !kill <window> - Terminate a session
  if (cmd.startsWith('!kill ')) {
    const windowName = text.slice(6).trim();
    if (!windowName) {
      await say(':warning: Usage: `!kill <window-name>`\nUse `!sessions` to see active windows.');
      return true;
    }

    const sessions = loadSessions();
    const entry = Object.entries(sessions).find(([_, s]) => s.window === windowName && s.status !== 'terminated');

    if (!entry) {
      await say(`:warning: Session \`${windowName}\` not found or already terminated.`);
      return true;
    }

    const [threadTs, session] = entry;
    terminateSession(threadTs, session);
    await say(`:skull: Session \`${windowName}\` terminated.`);
    return true;
  }

  // !find <query> - Find project paths
  if (cmd.startsWith('!find ') || cmd.startsWith('!f ')) {
    const query = text.slice(cmd.startsWith('!f ') ? 3 : 6).trim().toLowerCase();
    if (!query) {
      await say(':warning: Usage: `!find <name>` - Search for project directories');
      return true;
    }

    try {
      const home = process.env.HOME;

      // Find directories with .git, package.json, Cargo.toml, go.mod, etc.
      const result = execSync(
        `find ~ -maxdepth 4 -type d -iname "*${query}*" 2>/dev/null | head -20`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();

      if (!result) {
        await say(`:mag: No directories found matching \`${query}\``);
        return true;
      }

      const paths = result.split('\n')
        .map(p => p.replace(home, '~'))
        .slice(0, 10);

      await say(`:mag: Found ${paths.length} matching "${query}":`);
      for (const p of paths) {
        await say(p);
      }
    } catch (err) {
      await say(`:warning: Search failed: ${err.message}`);
    }
    return true;
  }

  // !help - Show available commands
  if (cmd === '!help' || cmd === '!h') {
    await say(
      `:information_source: *Bot Commands*\n` +
      `• \`!sessions\` or \`!s\` - List active sessions\n` +
      `• \`!status\` - Show bridge status\n` +
      `• \`!find <name>\` or \`!f\` - Find project directories\n` +
      `• \`!kill <window>\` - Terminate a session\n` +
      `• \`!help\` - Show this help\n\n` +
      `To start a Claude session, just send a message (creates new thread).\n` +
      `Use \`[/path]\` prefix to set a custom working directory.`
    );
    return true;
  }

  return false; // Not a recognized command
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
  const threadTs = message.thread_ts || message.ts;
  const text = message.text?.trim() || '';
  console.log(`[${new Date().toISOString()}] Message from ${message.user}${isThread ? ' (in thread)' : ''}: ${text.substring(0, 100) || '(empty)'}`);

  // Check if this thread is a Claude session
  const sessions = loadSessions();
  const isClaudeSession = isThread && sessions[message.thread_ts];

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

// ============================================
// Slash Commands
// ============================================

// /claude-sessions - List active sessions
app.command('/claude-sessions', async ({ command, ack, respond }) => {
  await ack();

  if (config.allowedUsers && config.allowedUsers.length > 0) {
    if (!config.allowedUsers.includes(command.user_id)) {
      await respond("Sorry, you're not authorized.");
      return;
    }
  }

  const sessions = loadSessions();
  const activeSessions = Object.entries(sessions).filter(([_, s]) => s.status !== 'terminated');

  if (activeSessions.length === 0) {
    await respond(':information_source: No active sessions.');
    return;
  }

  const now = new Date();
  const lines = activeSessions.map(([threadTs, s]) => {
    const idleTime = s.idle_since ? Math.round((now - new Date(s.idle_since)) / 1000) : 0;
    const statusEmoji = s.status === 'idle' ? ':zzz:' : s.status === 'starting' ? ':hourglass:' : ':green_circle:';
    const idleStr = s.status === 'idle' ? ` (idle ${idleTime}s)` : '';
    const dir = s.workingDir?.replace(process.env.HOME, '~') || '~';
    return `${statusEmoji} \`${s.window}\` - ${dir}${idleStr}`;
  });

  await respond(`:clipboard: *Active Sessions (${activeSessions.length}/${config.multiSession.maxConcurrent})*\n${lines.join('\n')}`);
});

// /claude-status - Show bridge status
app.command('/claude-status', async ({ command, ack, respond }) => {
  await ack();

  if (config.allowedUsers && config.allowedUsers.length > 0) {
    if (!config.allowedUsers.includes(command.user_id)) {
      await respond("Sorry, you're not authorized.");
      return;
    }
  }

  const sessions = loadSessions();
  const active = Object.values(sessions).filter(s => s.status !== 'terminated').length;
  const idle = Object.values(sessions).filter(s => s.status === 'idle').length;
  const terminated = Object.values(sessions).filter(s => s.status === 'terminated').length;

  const tmuxOk = tmuxSessionExists() ? ':white_check_mark:' : ':x:';

  await respond(
    `:robot_face: *Claude Code Bridge Status*\n` +
    `• tmux session \`${TMUX_SESSION}\`: ${tmuxOk}\n` +
    `• Active sessions: ${active}/${config.multiSession.maxConcurrent}\n` +
    `• Idle sessions: ${idle}\n` +
    `• Terminated (can resurrect): ${terminated}\n` +
    `• Idle timeout: ${config.multiSession.idleTimeoutMinutes} minutes`
  );
});

// /claude-kill - Terminate a session
app.command('/claude-kill', async ({ command, ack, respond }) => {
  await ack();

  if (config.allowedUsers && config.allowedUsers.length > 0) {
    if (!config.allowedUsers.includes(command.user_id)) {
      await respond("Sorry, you're not authorized.");
      return;
    }
  }

  const windowName = command.text.trim();
  if (!windowName) {
    await respond(':warning: Usage: `/claude-kill <window-name>`\nUse `/claude-sessions` to see active windows.');
    return;
  }

  const sessions = loadSessions();
  const entry = Object.entries(sessions).find(([_, s]) => s.window === windowName && s.status !== 'terminated');

  if (!entry) {
    await respond(`:warning: Session \`${windowName}\` not found or already terminated.`);
    return;
  }

  const [threadTs, session] = entry;
  terminateSession(threadTs, session);
  await respond(`:skull: Session \`${windowName}\` terminated.`);
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
