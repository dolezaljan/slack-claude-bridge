import Bolt from '@slack/bolt';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const { App } = Bolt;

// Configuration
const CONFIG_DIR = process.env.HOME + '/.claude/slack-bridge';
const THREAD_CONTEXT_FILE = '/tmp/claude-slack-thread-context.json';
const TMUX_SESSION = process.env.CLAUDE_TMUX_SESSION || 'claude';
const TMUX_WINDOW = process.env.CLAUDE_TMUX_WINDOW || '0';

// Load tokens from config file
function loadConfig() {
  const configPath = `${CONFIG_DIR}/config.json`;
  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    console.error('Create it with: {"botToken": "xoxb-...", "appToken": "xapp-...", "allowedUsers": ["U..."]}');
    process.exit(1);
  }
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

const config = loadConfig();

// Initialize Slack app with Socket Mode
const app = new App({
  token: config.botToken,
  appToken: config.appToken,
  socketMode: true,
});

// Check if tmux session exists
function tmuxSessionExists() {
  try {
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

// Save thread context for slack-notify.sh to use
function saveThreadContext(channel, threadTs, messageTs) {
  const context = {
    channel,
    thread_ts: threadTs || null,
    message_ts: messageTs || null,  // For removing reaction after response
    updated_at: new Date().toISOString()
  };
  writeFileSync(THREAD_CONTEXT_FILE, JSON.stringify(context, null, 2));
  console.log(`[${new Date().toISOString()}] Thread context saved: ${threadTs ? `thread ${threadTs}` : 'main conversation'}`);
}

// Sleep helper
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Capture current tmux pane content
function capturePaneContent() {
  try {
    return execSync(
      `tmux capture-pane -t ${TMUX_SESSION}:${TMUX_WINDOW} -p`,
      { encoding: 'utf-8' }
    );
  } catch {
    return '';
  }
}

// Check if pane shows bracketed/large input indicator
function hasLargeInputIndicator(content) {
  // Look for patterns like [1234 characters] or [pasted ...] at end
  const lines = content.trim().split('\n');
  const lastLines = lines.slice(-3).join('\n');
  return /\[.*\d+.*\]|\[pasted|\[large/i.test(lastLines);
}

// Send a single key press (for option selection)
function sendKey(key) {
  if (!tmuxSessionExists()) {
    return { success: false, error: `tmux session '${TMUX_SESSION}' not found` };
  }

  try {
    execSync(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_WINDOW} '${key}'`);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
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

// Send text to Claude Code via tmux
async function sendToClaude(text) {
  if (!tmuxSessionExists()) {
    return { success: false, error: `tmux session '${TMUX_SESSION}' not found` };
  }

  try {
    // Check if this is an option selection
    if (isOptionSelection(text)) {
      const key = getOptionKey(text);
      if (key) {
        console.log(`[${new Date().toISOString()}] Sending option key: ${key}`);
        return sendKey(key);
      }
    }

    // Escape special characters for tmux
    const escaped = text.replace(/'/g, "'\\''");

    // Send the text to the tmux session (use -l for literal text)
    execSync(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_WINDOW} -l '${escaped}'`);

    // Always send Enter twice to handle paste mode
    // First Enter: may just add newline if in multiline/paste mode
    // Second Enter: submits on empty line, confirming input
    execSync(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_WINDOW} Enter`);
    await sleep(100);
    execSync(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_WINDOW} Enter`);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Handle direct messages to the bot
app.message(async ({ message, say, client }) => {
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

  const text = message.text;
  const isThread = !!message.thread_ts;
  console.log(`[${new Date().toISOString()}] Message from ${message.user}${isThread ? ' (in thread)' : ''}: ${text}`);

  // Save thread context for response routing
  // If message is in main convo, use message.ts as thread_ts to start a new thread
  const threadTs = message.thread_ts || message.ts;
  saveThreadContext(message.channel, threadTs, message.ts);

  // Send to Claude Code
  const result = await sendToClaude(text);

  if (result.success) {
    // React with eyes to show we received it
    try {
      await client.reactions.add({
        channel: message.channel,
        name: 'eyes',
        timestamp: message.ts
      });
    } catch (e) {
      // Ignore reaction errors
    }
  } else {
    await say(`:warning: Failed to send to Claude: ${result.error}`);
  }
});

// Handle app mentions in channels
app.event('app_mention', async ({ event, say, client }) => {
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
  console.log(`[${new Date().toISOString()}] Mention from ${event.user}${isThread ? ' (in thread)' : ''}: ${text}`);

  // Save thread context for response routing
  // If message is in main convo, use event.ts as thread_ts to start a new thread
  const threadTs = event.thread_ts || event.ts;
  saveThreadContext(event.channel, threadTs, event.ts);

  const result = await sendToClaude(text);

  if (result.success) {
    try {
      await client.reactions.add({
        channel: event.channel,
        name: 'eyes',
        timestamp: event.ts
      });
    } catch (e) {
      // Ignore reaction errors
    }
  } else {
    await say(`:warning: Failed to send to Claude: ${result.error}`);
  }
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

  const result = await sendToClaude(text);

  if (result.success) {
    await respond(`:white_check_mark: Sent to Claude: \`${text}\``);
  } else {
    await respond(`:warning: Failed: ${result.error}`);
  }
});

// Start the app
(async () => {
  await app.start();
  console.log('');
  console.log('===========================================');
  console.log('  Claude Code Slack Bridge is running!');
  console.log('===========================================');
  console.log('');
  console.log(`Forwarding messages to tmux session: ${TMUX_SESSION}:${TMUX_WINDOW}`);
  console.log('');
  console.log('To use:');
  console.log('  1. Start Claude Code in tmux: tmux new -s claude');
  console.log('  2. DM the bot or @mention it in a channel');
  console.log('');

  if (!tmuxSessionExists()) {
    console.warn(`⚠️  Warning: tmux session '${TMUX_SESSION}' not found!`);
    console.warn(`   Start it with: tmux new -s ${TMUX_SESSION}`);
  } else {
    console.log(`✓ tmux session '${TMUX_SESSION}' found`);
  }
})();
